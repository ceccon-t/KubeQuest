/**
 * The HTTP client behind `curl`/`wget`, from the workstation and from inside containers: where a URL connects to
 * (port-forwards, NodePorts, LoadBalancer IPs, cluster DNS, pod IPs), TLS verification and curl's output/errors.
 */
import type { Engine } from './engine.ts';
import type { Pod, Service, Node } from './types.ts';
import type { OutputChunk } from './kubectl/context.ts';
import { out, err } from './kubectl/context.ts';
import { requestPod, type NetResult, type RequestInfo } from './appsim.ts';
import { resolveDns, serviceBackends, resolveTargetPort } from './controllers/service.ts';
import { EXTERNAL, podPeer, dnsAllowed } from './netpol.ts';
import type { CertInfo } from './encoding.ts';
import type { PortForward } from './kubectl/commands/logs.ts';

/** Why a client that verifies certificates would reject this one (OpenSSL 3 wording), or undefined when it is fine. */
export function certProblem(engine: Engine, cert: CertInfo, host: string): string | undefined {
  if (Date.parse(cert.notAfter) < engine.clock.nowMs) return 'SSL certificate problem: certificate has expired';
  if (!engine.trustedIssuers.includes(cert.issuer)) return cert.issuer === cert.subject ? 'SSL certificate problem: self-signed certificate' : 'SSL certificate problem: unable to get local issuer certificate';
  const ok = cert.sans.some((s) => s === host || (s.startsWith('*.') && host.includes('.') && host.slice(host.indexOf('.') + 1) === s.slice(2)));
  return ok ? undefined : `SSL: no alternative certificate subject name matches target host name '${host}'`;
}

const STATUS_TEXT: Record<number, string> = { 200: 'OK', 201: 'Created', 204: 'No Content', 301: 'Moved Permanently', 302: 'Found', 308: 'Permanent Redirect', 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 500: 'Internal Server Error', 502: 'Bad Gateway', 503: 'Service Unavailable', 504: 'Gateway Timeout' };

export interface CurlOptions {
  url?: string;
  hostHeader?: string;
  resolve: Map<string, string>;
  insecure: boolean;
  silent: boolean;
  showErrors: boolean;
  head: boolean;
  include: boolean;
  verbose: boolean;
  follow: boolean;
  fail: boolean;
  output?: string;
  writeOut?: string;
}

const VALUE_FLAGS = new Set(['-o', '--output', '-H', '--header', '-X', '--request', '-d', '--data', '-m', '--max-time', '--connect-timeout', '-u', '--user', '-A', '--user-agent', '-w', '--write-out', '-e', '--resolve', '--cacert', '--retry']);

export function parseCurlArgs(args: string[]): CurlOptions {
  const o: CurlOptions = { resolve: new Map(), insecure: false, silent: false, showErrors: false, head: false, include: false, verbose: false, follow: false, fail: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (VALUE_FLAGS.has(a)) {
      const v = args[++i] ?? '';
      if (a === '-H' || a === '--header') { const m = /^host:\s*(.+)$/i.exec(v); if (m) o.hostHeader = (m[1] as string).trim(); }
      else if (a === '--resolve') { const m = /^([^:]+):(\d+):(.+)$/.exec(v); if (m) o.resolve.set(`${m[1]}:${m[2]}`, m[3] as string); }
      else if (a === '-o' || a === '--output') o.output = v;
      else if (a === '-w' || a === '--write-out') o.writeOut = v;
      continue;
    }
    if (a.startsWith('--')) {
      if (a === '--insecure') o.insecure = true; else if (a === '--silent') o.silent = true; else if (a === '--show-error') o.showErrors = true; else if (a === '--head') o.head = true;
      else if (a === '--include') o.include = true; else if (a === '--verbose') o.verbose = true; else if (a === '--location') o.follow = true; else if (a === '--fail') o.fail = true;
      continue;
    }
    if (a.startsWith('-') && a.length > 1) {
      for (const f of a.slice(1)) {
        if (f === 'k') o.insecure = true; else if (f === 's') o.silent = true; else if (f === 'S') o.showErrors = true; else if (f === 'I') o.head = true;
        else if (f === 'i') o.include = true; else if (f === 'v') o.verbose = true; else if (f === 'L') o.follow = true; else if (f === 'f') o.fail = true;
      }
      continue;
    }
    if (o.url === undefined) o.url = a;
  }
  return o;
}

/** Where the client runs: a pod (cluster network, cluster DNS) or the on-call workstation (outside the cluster). */
export interface HttpClient { pod?: Pod; writeFile?: (path: string, content: string) => void }

type Failure = { failed: true; code: number; message: string };
type Attempt = NetResult | Failure;
const fail = (code: number, message: string): Failure => ({ failed: true, code, message });

function viaService(engine: Engine, svc: Service, port: number, path: string, req: RequestInfo): Attempt | undefined {
  const sp = (svc.spec.ports ?? []).find((p) => p.port === port);
  if (!sp) return undefined;
  const { ready } = serviceBackends(engine, svc);
  if (!ready.length) return { ok: false, error: 'refused' };
  const pod = ready[engine.rng.int(ready.length)] as Pod;
  return requestPod(engine, pod, resolveTargetPort(svc, sp, pod), path, req);
}

function attempt(engine: Engine, client: HttpClient, shown: string, addr: string, port: number, path: string, tls: boolean, hostHeader: string): Attempt {
  const refused = (ms: number): Failure => fail(7, `Failed to connect to ${shown} port ${port} after ${ms} ms: Couldn't connect to server`);
  const isIp = /^\d+\.\d+\.\d+\.\d+$/.test(addr);
  const nodes = engine.store.list<Node>('Node');
  const isNode = isIp && nodes.some((n) => n.status.addresses.some((a) => a.address === addr));
  const edge = (svc: Service): boolean => (svc.status.loadBalancer?.ingress?.[0]?.ip === addr && (svc.spec.ports ?? []).some((p) => p.port === port)) || (isNode && (svc.spec.ports ?? []).some((p) => p.nodePort === port));
  const throughEdge = (req: RequestInfo): Attempt | undefined => {
    for (const svc of engine.store.list<Service>('Service')) {
      if (!edge(svc)) continue;
      const sp = (svc.spec.ports ?? []).find((p) => (svc.status.loadBalancer?.ingress?.[0]?.ip === addr && p.port === port) || (isNode && p.nodePort === port));
      const r = sp ? viaService(engine, svc, sp.port, path, req) : undefined;
      if (r) return 'ok' in r && !r.ok && r.error === 'refused' ? refused(1) : r;
    }
    return undefined;
  };
  if (!client.pod) {
    // --- the workstation: outside the cluster network ---
    const req: RequestInfo = { host: hostHeader, tls, from: EXTERNAL };
    if (addr === 'localhost' || addr === '127.0.0.1') {
      const forwards = (engine.scratch.get('port-forwards') as PortForward[] | undefined) ?? [];
      const f = forwards.find((x) => x.local === port);
      if (!f) return refused(0);
      const pod = f.target.pod ? engine.store.getByUid<Pod>(f.target.pod.metadata.uid as string) : undefined;
      if (!pod) return fail(52, 'Empty reply from server');
      const r = requestPod(engine, pod, f.remote, path, { host: hostHeader, tls });
      if (!r.ok) return r.error === 'refused' ? fail(56, 'Recv failure: Connection reset by peer') : r.error === 'not-tls' ? r : fail(28, 'Operation timed out');
      return r;
    }
    if (isIp) {
      const r = throughEdge(req);
      if (r) return r;
      return isNode ? refused(3) : fail(28, `Failed to connect to ${shown} port ${port} after 5000 ms: Connection timed out`);
    }
    // Service names only resolve inside the cluster — a classic first surprise
    return fail(6, `Could not resolve host: ${shown}`);
  }
  // --- inside a pod ---
  const self = client.pod;
  const req: RequestInfo = { host: hostHeader, tls, from: podPeer(self), fromPod: self };
  if (addr === 'localhost' || addr === '127.0.0.1') {
    const r = requestPod(engine, self, port, path, { host: hostHeader, tls });
    return !r.ok && r.error === 'refused' ? refused(0) : r;
  }
  if (isIp) {
    const pod = engine.store.list<Pod>('Pod').find((p) => p.status.podIP === addr);
    if (pod) { const r = requestPod(engine, pod, port, path, req); return !r.ok && r.error === 'refused' ? refused(2) : r; }
    const svc = engine.store.list<Service>('Service').find((s) => s.spec.clusterIP === addr);
    if (svc) { const r = viaService(engine, svc, port, path, req); return !r || ('ok' in r && !r.ok && r.error === 'refused') ? refused(1) : r; }
    const e = throughEdge(req);
    if (e) return e;
    return fail(28, `Failed to connect to ${shown} port ${port} after 5000 ms: Connection timed out`);
  }
  if (!dnsAllowed(engine, self)) return fail(6, `Could not resolve host: ${shown}`);
  const dns = resolveDns(engine, addr, self.metadata.namespace ?? 'default');
  if (!dns) return fail(6, `Could not resolve host: ${shown}`);
  if (dns.pod) { const r = requestPod(engine, dns.pod, port, path, req); return !r.ok && r.error === 'refused' ? refused(2) : r; }
  const r = dns.svc ? viaService(engine, dns.svc, port, path, req) : undefined;
  return !r || ('ok' in r && !r.ok && r.error === 'refused') ? refused(1) : r;
}

export interface HttpOutcome { chunks: OutputChunk[]; code: number; status?: number }

/** Run curl (or busybox wget) with the given arguments. */
export function runCurl(engine: Engine, client: HttpClient, cmd: 'curl' | 'wget', rawArgs: string[]): HttpOutcome {
  // busybox wget: -T SEC (network timeout) and -t N (tries) take a value; neither changes what the simulation answers
  const args = cmd === 'wget' ? rawArgs.filter((a, i) => !(['-T', '-t'].includes(a) || ['-T', '-t'].includes(rawArgs[i - 1] ?? '')) && !/^--(timeout|tries)=/.test(a)) : rawArgs;
  const wgetTimeout = cmd === 'wget' && rawArgs.some((a) => a === '-T' || a.startsWith('--timeout='));
  const o = parseCurlArgs(args);
  if (!o.url) return { chunks: [err(cmd === 'curl' ? "curl: try 'curl --help' or 'curl --manual' for more information\n" : 'wget: missing URL\n')], code: 2 };
  const chunks: OutputChunk[] = [];
  let url = o.url;
  for (let hop = 0; hop < 6; hop++) {
    const m = /^(?:(https?):\/\/)?([^/:]+)(?::(\d+))?(\/.*)?$/.exec(url);
    if (!m) return { chunks: [err('curl: (3) URL using bad/illegal format or missing URL\n')], code: 3 };
    const tls = m[1] === 'https';
    const host = m[2] as string;
    const port = m[3] ? parseInt(m[3], 10) : tls ? 443 : 80;
    const path = m[4] ?? '/';
    const addr = o.resolve.get(`${host}:${port}`) ?? host;
    const hostHeader = o.hostHeader ?? host;
    const quiet = o.silent && !o.showErrors;
    const failure = (code: number, message: string, extra = ''): HttpOutcome => {
      if (cmd === 'wget') {
        // busybox wget: with -T the alarm fires first ("download timed out"); without it connect() gives up after the kernel's SYN retries
        const where = /^\d/.test(addr) ? ` (${addr})` : '';
        const text = code === 6 ? `wget: bad address '${host}'\n` : code === 28 ? (wgetTimeout ? 'wget: download timed out\n' : `wget: can't connect to remote host${where}: Connection timed out\n`) : `wget: can't connect to remote host${where}: Connection refused\n`;
        return { chunks: [...chunks, err(text)], code: 1 };
      }
      const tail = o.writeOut ? [out(o.writeOut.replace(/%\{http_code\}/g, '000').replace(/\\n/g, '\n'))] : [];
      return { chunks: [...chunks, ...tail, ...(quiet ? [] : [err(`curl: (${code}) ${message}\n${extra}`)])], code };
    };
    if (o.verbose && cmd === 'curl') chunks.push(err(`*   Trying ${addr}:${port}...\n`));
    const r = attempt(engine, client, host, addr, port, path, tls, hostHeader);
    if ('failed' in r) return failure(r.code, r.message);
    if (!r.ok) {
      if (r.error === 'not-tls') return failure(35, 'error:0A00010B:SSL routines::wrong version number'); // TODO(fidelity): exact OpenSSL text varies by build
      if (r.error === 'refused') return failure(7, `Failed to connect to ${host} port ${port} after 1 ms: Couldn't connect to server`);
      return failure(28, 'Connection timed out after 5001 milliseconds');
    }
    if (o.verbose && cmd === 'curl') chunks.push(err(`* Connected to ${host} (${addr}) port ${port}\n`));
    if (tls) {
      if (!r.cert) return failure(35, 'error:0A00010B:SSL routines::wrong version number');
      if (o.verbose && cmd === 'curl') chunks.push(err(`* Server certificate:\n*  subject: ${r.cert.subject}\n*  expire date: ${new Date(r.cert.notAfter).toUTCString()}\n*  issuer: ${r.cert.issuer}\n`));
      const problem = o.insecure ? undefined : certProblem(engine, r.cert, hostHeader);
      if (problem) return failure(60, problem, 'More details here: https://curl.se/docs/sslcerts.html\n\ncurl failed to verify the legitimacy of the server and therefore could not\nestablish a secure connection to it. To learn more about this situation and\nhow to fix it, please visit the web page mentioned above.\n');
      if (o.verbose && cmd === 'curl') chunks.push(err(o.insecure ? '*  SSL certificate verify result: skipped (--insecure)\n' : '*  SSL certificate verify ok.\n'));
    }
    const text = STATUS_TEXT[r.status] ?? '';
    if (cmd === 'wget') {
      if (r.status >= 400) return { chunks: [err(`wget: server returned error: HTTP/1.1 ${r.status} ${text}\n`)], code: 1, status: r.status };
      if (args.includes('-qO-') || args.includes('-O-') || (args.includes('-O') && args.includes('-'))) return { chunks: [out(r.body)], code: 0, status: r.status };
      return { chunks: [out(`Connecting to ${url.replace(/^https?:\/\//, '')}\nsaving to 'index.html'\nindex.html           100% |********************************|   ${r.body.length}  0:00:00 ETA\n'index.html' saved\n`)], code: 0, status: r.status };
    }
    if (o.verbose) chunks.push(err(`> ${o.head ? 'HEAD' : 'GET'} ${path} HTTP/1.1\n> Host: ${hostHeader}\n> User-Agent: curl/8.5.0\n> Accept: */*\n>\n< HTTP/1.1 ${r.status} ${text}\n${r.location ? `< Location: ${r.location}\n` : ''}<\n`));
    if (o.follow && r.location && r.status >= 300 && r.status < 400) { url = r.location; continue; }
    if (o.fail && r.status >= 400) return { ...failure(22, `The requested URL returned error: ${r.status}`), status: r.status };
    if (o.head || o.include) chunks.push(out(`HTTP/1.1 ${r.status} ${text}\n${r.location ? `Location: ${r.location}\n` : ''}Content-Type: text/plain; charset=utf-8\nContent-Length: ${r.body.length}\n\n`));
    if (!o.head) {
      if (o.output === undefined) chunks.push(out(r.body));
      else if (o.output !== '/dev/null') client.writeFile?.(o.output, r.body);
    }
    if (o.writeOut) chunks.push(out(o.writeOut.replace(/%\{http_code\}/g, String(r.status).padStart(3, '0')).replace(/\\n/g, '\n')));
    return { chunks, code: 0, status: r.status };
  }
  return { chunks: [...chunks, err('curl: (47) Maximum (50) redirects followed\n')], code: 47 };
}
