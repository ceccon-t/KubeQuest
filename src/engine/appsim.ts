/** How the (simulated) process inside a container answers network requests. Shared by probes, traffic and curl. */
import type { Engine } from './engine.ts';
import type { Pod } from './types.ts';
import type { ContainerRuntime } from './runtime.ts';
import { httpResponse } from './images.ts';
import type { CertInfo } from './encoding.ts';
import { connectionAllowed, podPeer, dnsAllowed, type Peer } from './netpol.ts';
import { resolveDns, serviceBackends, resolveTargetPort } from './controllers/service.ts';
import { routeIngress, routeGateway, gatewayOfProxy, nginxPage, type ProxyResult } from './routing.ts';
import { parseCpuMillis } from './duration.ts';

export type NetResult =
  | { ok: true; status: number; body: string; cert?: CertInfo; location?: string; servedBy?: string }
  | { ok: false; error: 'refused' | 'timeout' | 'unreachable' | 'not-tls' };

/** Who is asking and how. Requests without `from` (kubelet probes) are not subject to NetworkPolicy. */
export interface RequestInfo {
  host?: string;
  tls?: boolean;
  from?: Peer;
  fromPod?: Pod;
  /** Synthetic user traffic: counts towards the pod's load (CPU, HPA metrics) and can overload it. */
  load?: boolean;
}

export function isListening(rt: ContainerRuntime, now: number): boolean {
  if (rt.phase !== 'running' || rt.startedAt === undefined || !rt.behaviour) return false;
  return now >= rt.startedAt + rt.behaviour.startMs;
}

/** TCP connect to a container port. */
export function tcpConnect(rt: ContainerRuntime, port: number, now: number): NetResult {
  if (!isListening(rt, now)) return { ok: false, error: 'refused' };
  if (!rt.behaviour || !rt.behaviour.ports.includes(port)) return { ok: false, error: 'refused' };
  if (rt.hung) return { ok: false, error: 'timeout' };
  return { ok: true, status: 0, body: '' };
}

/** HTTP GET to a container port/path. */
export function httpGet(rt: ContainerRuntime, port: number, path: string, now: number): NetResult {
  const c = tcpConnect(rt, port, now);
  if (!c.ok) return c;
  const r = httpResponse(rt.behaviour!, path, now - (rt.startedAt as number));
  if (rt.degraded && path !== '/healthz') return { ok: true, status: 503, body: `${rt.degraded}\n` };
  // bodies may show the process's own configuration: {{env.NAME}} and, for datastores, {{records}}
  const body = r.body.includes('{{') ? r.body.replace(/\{\{env\.(\w+)\}\}/g, (_m, k: string) => rt.env[k] ?? '').replace(/\{\{records\}\}/g, String(rt.records ?? 0)) : r.body;
  return { ok: true, status: r.status, body };
}

/** Find the container runtime that owns a port in a pod (first container listening on it). */
export function containerForPort(engine: Engine, pod: Pod, port: number): ContainerRuntime | undefined {
  const rt = engine.podRuntime(pod);
  const app = rt.containers.filter((c) => !c.init && !c.ephemeral);
  for (const c of app) {
    const spec = pod.spec.containers.find((s) => s.name === c.name);
    const declared = spec?.ports?.some((p) => p.containerPort === port) ?? false;
    const listens = c.behaviour?.ports.includes(port) ?? false;
    if (declared || listens) return c;
  }
  return app[0];
}

/** Requests per second one replica can serve before it starts shedding load (CPU limit throttling included). */
export function podCapacity(pod: Pod, c: ContainerRuntime): number {
  const b = c.behaviour;
  let cap = typeof b?.capacityRps === 'number' ? b.capacityRps : Infinity;
  const per = typeof b?.cpuPerRequestMillis === 'number' ? b.cpuPerRequestMillis : 0;
  const lim = pod.spec.containers.find((s) => s.name === c.name)?.resources?.limits?.cpu;
  if (per > 0 && lim !== undefined) cap = Math.min(cap, Math.max(0, parseCpuMillis(lim) - (b?.cpuMillis ?? 0)) / per);
  return cap;
}

/** The app in `pod` calls `name:port/path` (cluster DNS, endpoints and NetworkPolicy apply). Returns why it failed, if it did. */
function upstreamFailure(engine: Engine, pod: Pod, target: string): string | undefined {
  const m = /^([^:/]+)(?::(\d+))?(\/.*)?$/.exec(target);
  if (!m) return 'bad address';
  const port = parseInt(m[2] ?? '80', 10);
  if (!dnsAllowed(engine, pod)) return 'dns lookup timed out';
  const dns = resolveDns(engine, m[1] as string, pod.metadata.namespace as string);
  if (!dns?.svc) return 'no such host';
  const sp = (dns.svc.spec.ports ?? []).find((p) => p.port === port);
  const backends = serviceBackends(engine, dns.svc).ready;
  if (!sp || !backends.length) return 'connection refused';
  const backend = backends[engine.rng.int(backends.length)] as Pod;
  const r = requestPod(engine, backend, resolveTargetPort(dns.svc, sp, backend), m[3] ?? '/', { from: podPeer(pod), fromPod: pod });
  if (!r.ok) return r.error === 'timeout' ? 'i/o timeout' : 'connection refused';
  return r.status >= 500 ? `status ${r.status}` : undefined;
}

/** HTTP request to a pod IP:port, as kube-proxy or another pod would make it. */
export function requestPod(engine: Engine, pod: Pod, port: number, path: string, req: RequestInfo = {}): NetResult {
  if (!pod.status.podIP) return { ok: false, error: 'unreachable' };
  const nodeRt = engine.nodeRuntime(pod.spec.nodeName ?? '');
  if (!nodeRt.ready) return { ok: false, error: 'timeout' };
  // a policy-enforcing CNI drops the packets: the client sees a timeout, not a refusal
  if (req.from && !connectionAllowed(engine, req.from, req.fromPod, pod, port)) return { ok: false, error: 'timeout' };
  const c = containerForPort(engine, pod, port);
  if (!c) return { ok: false, error: 'refused' };
  const now = engine.clock.nowMs;
  const proxy = c.behaviour?.proxy;
  if (proxy === 'ingress-nginx' || proxy === 'envoy-gateway') {
    if (!isListening(c, now)) return { ok: false, error: 'refused' };
    const host = req.host ?? pod.status.podIP;
    let r: ProxyResult;
    if (proxy === 'ingress-nginx') {
      if (port !== 80 && port !== 443) return { ok: false, error: 'refused' };
      if (port === 80 && req.tls) return { ok: false, error: 'not-tls' };
      if (port === 443 && !req.tls) return { ok: true, status: 400, body: nginxPage(400, 'The plain HTTP request was sent to HTTPS port') };
      r = routeIngress(engine, { host, path, tls: !!req.tls, port });
    } else {
      const gw = gatewayOfProxy(engine, pod);
      if (!gw) return { ok: false, error: 'refused' };
      r = routeGateway(engine, gw, { host, path, tls: !!req.tls, port });
    }
    if (r.kind === 'refused') return { ok: false, error: 'refused' };
    if (r.kind === 'response') return { ok: true, status: r.status, body: r.body, cert: r.cert, location: r.location };
    const up = requestPod(engine, r.pod, r.port, r.path, { host, from: podPeer(pod), fromPod: pod, load: req.load });
    if (up.ok) return { ...up, cert: r.cert };
    if (proxy === 'ingress-nginx') return up.error === 'timeout' ? { ok: true, status: 504, body: nginxPage(504, 'Gateway Time-out'), cert: r.cert } : { ok: true, status: 502, body: nginxPage(502, 'Bad Gateway'), cert: r.cert };
    return up.error === 'timeout' ? { ok: true, status: 504, body: 'upstream request timeout', cert: r.cert } : { ok: true, status: 503, body: 'upstream connect error or disconnect/reset before headers. reset reason: connection failure', cert: r.cert };
  }
  if (req.tls) return { ok: false, error: tcpConnect(c, port, now).ok ? 'not-tls' : 'refused' };
  let res = httpGet(c, port, path, now);
  // an endpoint that calls another service answers 502 when that call fails (multi-tier apps)
  const upRaw = c.behaviour?.upstreams?.[path.split('?')[0] as string];
  // the upstream address can come from the container's environment: `$VAR/path`
  const up = upRaw?.replace(/\$(\w+)/g, (_m, k: string) => c.env[k] ?? '');
  if (up && res.ok && res.status < 400) {
    const failure = upstreamFailure(engine, pod, up);
    if (failure) res = { ok: true, status: 502, body: `upstream ${up.split(':')[0]} unavailable: ${failure}\n` };
  }
  if (req.load && res.ok) {
    const uid = pod.metadata.uid as string;
    engine.traffic.recordHit(uid, now);
    const cap = podCapacity(pod, c);
    const rate = engine.traffic.podRate(uid);
    // beyond its capacity a replica sheds the excess: queues overflow and requests fail
    if (rate > cap && engine.rng.next() > cap / rate) return { ok: true, status: 503, body: 'overloaded\n', servedBy: uid };
    return { ...res, servedBy: uid };
  }
  return res;
}
