/** The shell "inside" a container: a tiny busybox-like environment for `kubectl exec` and `kubectl run -it`. */
import type { Engine } from './engine.ts';
import type { Pod, Service } from './types.ts';
import type { OutputChunk, ShellHost } from './kubectl/context.ts';
import { out, err } from './kubectl/context.ts';
import { resolveDns, serviceBackends, resolveTargetPort } from './controllers/service.ts';
import { requestPod } from './appsim.ts';
import { mountedFiles } from './controllers/kubelet.ts';
import { tokenize } from './kubectl/args.ts';

export interface ExecResult { chunks: OutputChunk[]; code: number }

function containerRuntime(engine: Engine, pod: Pod, container: string) {
  return engine.podRuntime(pod).containers.find((c) => c.name === container);
}

function baseFiles(engine: Engine, pod: Pod, container: string): Map<string, string> {
  const spec = pod.spec.containers.find((c) => c.name === container);
  const rt = containerRuntime(engine, pod, container);
  const files = new Map<string, string>();
  files.set('/etc/hostname', pod.metadata.name + '\n');
  files.set('/etc/hosts', `# Kubernetes-managed hosts file.\n127.0.0.1\tlocalhost\n::1\tlocalhost ip6-localhost ip6-loopback\n${pod.status.podIP ?? ''}\t${pod.metadata.name}\n`);
  files.set('/etc/resolv.conf', `search ${pod.metadata.namespace}.svc.cluster.local svc.cluster.local cluster.local\nnameserver 10.96.0.10\noptions ndots:5\n`);
  files.set('/var/run/secrets/kubernetes.io/serviceaccount/namespace', pod.metadata.namespace ?? 'default');
  files.set('/var/run/secrets/kubernetes.io/serviceaccount/token', 'eyJhbGciOiJSUzI1NiIsImtpZCI6Ik...(redacted)');
  for (const [k, v] of Object.entries(rt?.behaviour?.files ?? {})) files.set(k, v);
  if (spec) for (const [k, v] of mountedFiles(engine, pod, spec)) files.set(k, v);
  return files;
}

/** Perform an HTTP request from inside the cluster network (used by curl/wget and by `curl` to services). */
export function clusterHttp(engine: Engine, fromNamespace: string, url: string): { chunks: OutputChunk[]; code: number } {
  const m = /^(?:(https?):\/\/)?([^/:]+)(?::(\d+))?(\/.*)?$/.exec(url);
  if (!m) return { chunks: [err(`curl: (3) URL using bad/illegal format or missing URL\n`)], code: 3 };
  const host = m[2] as string;
  const port = m[3] ? parseInt(m[3], 10) : m[1] === 'https' ? 443 : 80;
  const path = m[4] ?? '/';
  // pod IP?
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    const pod = engine.store.list<Pod>('Pod').find((p) => p.status.podIP === host);
    if (pod) {
      const r = requestPod(engine, pod, port, path);
      if (r.ok) return { chunks: [out(r.body)], code: 0 };
      return { chunks: [err(r.error === 'refused' ? `curl: (7) Failed to connect to ${host} port ${port} after 2 ms: Couldn't connect to server\n` : `curl: (28) Connection timed out after 5001 milliseconds\n`)], code: r.error === 'refused' ? 7 : 28 };
    }
    const svc = engine.store.list<Service>('Service').find((s) => s.spec.clusterIP === host);
    if (svc) return viaService(engine, svc, port, path, host);
    return { chunks: [err(`curl: (28) Failed to connect to ${host} port ${port} after 5000 ms: Connection timed out\n`)], code: 28 };
  }
  if (host === 'localhost' || host === '127.0.0.1') return { chunks: [err(`curl: (7) Failed to connect to ${host} port ${port} after 0 ms: Couldn't connect to server\n`)], code: 7 };
  const dns = resolveDns(engine, host, fromNamespace);
  if (!dns) return { chunks: [err(`curl: (6) Could not resolve host: ${host}\n`)], code: 6 };
  return viaService(engine, dns.svc, port, path, host);
}

function viaService(engine: Engine, svc: Service, port: number, path: string, host: string): { chunks: OutputChunk[]; code: number } {
  const sp = (svc.spec.ports ?? []).find((p) => p.port === port);
  if (!sp) return { chunks: [err(`curl: (7) Failed to connect to ${host} port ${port} after 1 ms: Couldn't connect to server\n`)], code: 7 };
  const { ready } = serviceBackends(engine, svc);
  if (!ready.length) return { chunks: [err(`curl: (7) Failed to connect to ${host} port ${port} after 1 ms: Couldn't connect to server\n`)], code: 7 };
  const pod = ready[engine.rng.int(ready.length)] as Pod;
  const target = resolveTargetPort(svc, sp, pod);
  const r = requestPod(engine, pod, target, path);
  if (r.ok) return { chunks: [out(r.body)], code: 0 };
  return { chunks: [err(r.error === 'refused' ? `curl: (7) Failed to connect to ${host} port ${port} after 1 ms: Couldn't connect to server\n` : `curl: (28) Connection timed out after 5001 milliseconds\n`)], code: r.error === 'refused' ? 7 : 28 };
}

/** Run one command inside the container (non-interactive). */
export function execInContainer(engine: Engine, pod: Pod, container: string, argv: string[]): ExecResult {
  const rt = containerRuntime(engine, pod, container);
  const b = rt?.behaviour;
  const files = baseFiles(engine, pod, container);
  const env = rt?.env ?? {};
  const [cmd, ...args] = argv;
  if (!cmd) return { chunks: [], code: 0 };
  const notFound = (c: string): ExecResult => ({ chunks: [err(`OCI runtime exec failed: exec failed: unable to start container process: exec: "${c}": executable file not found in $PATH: unknown\n`)], code: 126 });
  if (b && b.hasShell === false && !['env', 'printenv'].includes(cmd)) return notFound(cmd);
  switch (cmd) {
    case 'sh': case 'bash': case '/bin/sh': case '/bin/bash': {
      if (args[0] === '-c' && args[1] !== undefined) {
        const inner = tokenize(args[1]) ?? [];
        return execInContainer(engine, pod, container, inner);
      }
      return { chunks: [], code: 0 };
    }
    case 'env': case 'printenv': {
      if (cmd === 'printenv' && args[0]) return env[args[0]] !== undefined ? { chunks: [out(env[args[0]] + '\n')], code: 0 } : { chunks: [], code: 1 };
      return { chunks: [out(Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n') + '\n')], code: 0 };
    }
    case 'echo': return { chunks: [out(args.map((a) => a.replace(/^\$(\w+)$/, (_m, k: string) => env[k] ?? '')).join(' ') + '\n')], code: 0 };
    case 'hostname': return { chunks: [out(pod.metadata.name + '\n')], code: 0 };
    case 'id': return { chunks: [out('uid=0(root) gid=0(root) groups=0(root)\n')], code: 0 };
    case 'whoami': return { chunks: [out('root\n')], code: 0 };
    case 'pwd': return { chunks: [out('/\n')], code: 0 };
    case 'uname': return { chunks: [out(args.includes('-a') ? `Linux ${pod.metadata.name} 6.8.0-142-generic #1 SMP x86_64 GNU/Linux\n` : 'Linux\n')], code: 0 };
    case 'ps': return { chunks: [out(`PID   USER     TIME  COMMAND\n    1 root      0:00 ${b ? (pod.spec.containers.find((c) => c.name === container)?.command?.join(' ') ?? '/app/server') : 'sh'}\n   12 root      0:00 ${argv.join(' ')}\n`)], code: 0 };
    case 'cat': {
      if (!args.length) return { chunks: [], code: 0 };
      const chunks: OutputChunk[] = [];
      let code = 0;
      for (const f of args) {
        const p = f.startsWith('/') ? f : `/${f}`;
        const v = files.get(p);
        if (v === undefined) { chunks.push(err(`cat: can't open '${f}': No such file or directory\n`)); code = 1; }
        else chunks.push(out(v.endsWith('\n') ? v : v + '\n'));
      }
      return { chunks, code };
    }
    case 'ls': {
      const dirArg = args.find((a) => !a.startsWith('-')) ?? '/';
      const dir = dirArg.replace(/\/$/, '') || '/';
      const names = new Set<string>();
      const base = ['bin', 'dev', 'etc', 'home', 'lib', 'proc', 'root', 'sys', 'tmp', 'usr', 'var'];
      if (dir === '/') for (const b2 of base) names.add(b2);
      for (const k of files.keys()) {
        const prefix = dir === '/' ? '/' : dir + '/';
        if (k.startsWith(prefix)) { const rest = k.slice(prefix.length); names.add(rest.split('/')[0] as string); }
      }
      if (!names.size && !files.has(dir)) return { chunks: [err(`ls: ${dirArg}: No such file or directory\n`)], code: 1 };
      if (files.has(dir)) return { chunks: [out(dirArg + '\n')], code: 0 };
      return { chunks: [out([...names].sort().join('\n') + '\n')], code: 0 };
    }
    case 'nslookup': case 'dig': case 'host': {
      const name = args.find((a) => !a.startsWith('-'));
      if (!name) return { chunks: [err(`nslookup: missing host name\n`)], code: 1 };
      const r = resolveDns(engine, name, pod.metadata.namespace ?? 'default');
      if (!r) return { chunks: [out(`Server:\t\t10.96.0.10\nAddress:\t10.96.0.10:53\n\n`), err(`** server can't find ${name}: NXDOMAIN\n\n`)], code: 1 };
      const fq = `${r.svc.metadata.name}.${r.svc.metadata.namespace}.svc.cluster.local`;
      return { chunks: [out(`Server:\t\t10.96.0.10\nAddress:\t10.96.0.10:53\n\nName:\t${fq}\nAddress: ${r.ip}\n\n`)], code: 0 };
    }
    case 'curl': case 'wget': {
      const url = args.find((a) => !a.startsWith('-'));
      if (!url) return { chunks: [err(cmd === 'curl' ? 'curl: try \'curl --help\' for more information\n' : 'wget: missing URL\n')], code: 2 };
      const r = clusterHttp(engine, pod.metadata.namespace ?? 'default', url);
      if (cmd === 'wget') {
        if (r.code !== 0) return { chunks: [err(`wget: can't connect to remote host: ${r.chunks[0]?.text.includes('resolve') ? 'bad address' : 'Connection refused'}\n`)], code: 1 };
        if (!args.includes('-qO-') && !args.includes('-O-') && !(args.includes('-O') && args.includes('-'))) return { chunks: [out(`Connecting to ${url.replace(/^https?:\/\//, '')}\nsaving to 'index.html'\nindex.html           100% |********************************|   ${r.chunks[0]?.text.length ?? 0}  0:00:00 ETA\n'index.html' saved\n`)], code: 0 };
      }
      if (args.includes('-I') || args.includes('-i')) r.chunks.unshift(out(`HTTP/1.1 ${r.code === 0 ? '200 OK' : '503 Service Unavailable'}\nContent-Type: text/plain\n\n`));
      return r;
    }
    case 'sleep': return { chunks: [], code: 0 };
    case 'true': return { chunks: [], code: 0 };
    case 'false': return { chunks: [], code: 1 };
    case 'exit': return { chunks: [], code: parseInt(args[0] ?? '0', 10) || 0 };
    case 'date': return { chunks: [out(new Date(engine.clock.nowMs).toUTCString().replace('GMT', 'UTC') + '\n')], code: 0 };
    case 'df': return { chunks: [out('Filesystem           1K-blocks      Used Available Use% Mounted on\noverlay               61202244  12345678  45678901  21% /\n')], code: 0 };
    case 'free': return { chunks: [out(`              total        used        free      shared  buff/cache   available\nMem:        8388608     ${(rt?.memoryMiB ?? 0) * 1024}     ${8388608 - (rt?.memoryMiB ?? 0) * 1024}           0           0     ${8388608 - (rt?.memoryMiB ?? 0) * 1024}\n`)], code: 0 };
    case 'kill': return { chunks: [], code: 0 };
    case 'which': return (args[0] && ['sh', 'ls', 'cat', 'env', 'curl', 'wget', 'nslookup'].includes(args[0])) ? { chunks: [out(`/bin/${args[0]}\n`)], code: 0 } : { chunks: [], code: 1 };
    default:
      return notFound(cmd);
  }
}

/** Interactive session: prompt loop until exit/EOF. */
export async function* interactiveShell(engine: Engine, host: ShellHost, pod: Pod, container: string, argv: string[]): AsyncGenerator<OutputChunk, number> {
  const cmd = argv[0] ?? 'sh';
  if (!['sh', 'bash', '/bin/sh', '/bin/bash', 'ash'].includes(cmd)) {
    const r = execInContainer(engine, pod, container, argv);
    for (const c of r.chunks) yield c;
    return r.code;
  }
  const rt = containerRuntime(engine, pod, container);
  if (rt?.behaviour && rt.behaviour.hasShell === false) {
    yield err(`OCI runtime exec failed: exec failed: unable to start container process: exec: "${cmd}": executable file not found in $PATH: unknown\n`);
    return 126;
  }
  let code = 0;
  while (!host.aborted()) {
    const line = await host.readLine('/ # ');
    if (line === null) break;
    const tokens = tokenize(line) ?? [];
    if (!tokens.length) continue;
    if (tokens[0] === 'exit') { code = parseInt(tokens[1] ?? '0', 10) || 0; break; }
    const live = engine.store.getByUid<Pod>(pod.metadata.uid as string);
    if (!live) { yield err('command terminated with exit code 137\n'); return 137; }
    const r = execInContainer(engine, live, container, tokens);
    for (const c of r.chunks) yield c;
    code = r.code;
  }
  return code;
}
