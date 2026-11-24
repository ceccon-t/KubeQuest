/**
 * L7 routing done by the data planes the simulator knows: ingress-nginx (Ingress) and Envoy Gateway (Gateway API).
 * A request that reaches one of their proxy pods is resolved here to a backend pod or to the proxy's own answer.
 */
import type { Engine } from './engine.ts';
import type { Ingress, IngressBackend, KubeObject, Pod, Secret, Service, Namespace } from './types.ts';
import { serviceBackends, resolveTargetPort } from './controllers/service.ts';
import { b64decode, parseCertPem, type CertInfo } from './encoding.ts';
import { fromLabelSelector, matches } from './selector.ts';
import type { Peer } from './netpol.ts';

export const NGINX_CONTROLLER = 'k8s.io/ingress-nginx';
export const ENVOY_CONTROLLER = 'gateway.envoyproxy.io/gatewayclass-controller';
export const GW_GROUP = 'gateway.networking.k8s.io';

export const FAKE_CERT: CertInfo = { subject: 'O=Acme Co, CN=Kubernetes Ingress Controller Fake Certificate', sans: ['ingress.local'], issuer: 'O=Acme Co, CN=Kubernetes Ingress Controller Fake Certificate', notAfter: '2099-01-01T00:00:00Z' };

/** nginx built-in error page (server_tokens off). */
export function nginxPage(status: number, text: string): string {
  return `<html>\r\n<head><title>${status} ${text}</title></head>\r\n<body>\r\n<center><h1>${status} ${text}</h1></center>\r\n<hr><center>nginx</center>\r\n</body>\r\n</html>\r\n`;
}

export interface ProxyRequest { host: string; path: string; tls: boolean; port: number }
export type ProxyResult =
  | { kind: 'response'; status: number; body: string; cert?: CertInfo; location?: string }
  | { kind: 'forward'; pod: Pod; port: number; path: string; cert?: CertInfo }
  | { kind: 'refused' };

function hostMatches(pattern: string | undefined, host: string): boolean {
  if (!pattern) return true;
  if (pattern.startsWith('*.')) { const rest = host.slice(host.indexOf('.') + 1); return host.includes('.') && rest === pattern.slice(2); }
  return pattern === host;
}

function pathMatches(type: string, pattern: string, path: string): boolean {
  const clean = path.split('?')[0] as string;
  if (type === 'Exact') return clean === pattern;
  if (pattern === '/' || pattern === '') return true;
  const p = pattern.replace(/\/$/, '');
  return clean === p || clean.startsWith(p + '/');
}

export function tlsSecretCert(engine: Engine, ns: string | undefined, name: string | undefined): CertInfo | undefined {
  if (!name) return undefined;
  const s = engine.store.get<Secret>('Secret', ns, name);
  if (!s || s.type !== 'kubernetes.io/tls') return undefined;
  const pem = b64decode(s.data?.['tls.crt'] ?? '');
  return pem ? parseCertPem(pem) : undefined;
}

function pickBackend(engine: Engine, svc: Service, portRef: { number?: number; name?: string } | undefined): { pod: Pod; port: number } | undefined {
  const sp = (svc.spec.ports ?? []).find((p) => (portRef?.number !== undefined && p.port === portRef.number) || (portRef?.name !== undefined && p.name === portRef.name));
  if (!sp) return undefined;
  const { ready } = serviceBackends(engine, svc);
  if (!ready.length) return undefined;
  const pod = ready[engine.rng.int(ready.length)] as Pod;
  return { pod, port: resolveTargetPort(svc, sp, pod) };
}

// ---------------------------------------------------------------------------
// Ingress (ingress-nginx)
// ---------------------------------------------------------------------------

/** IngressClass names served by ingress-nginx, and whether one of them is the cluster default. */
function nginxClasses(engine: Engine): { names: Set<string>; hasDefault: boolean } {
  const names = new Set<string>();
  let hasDefault = false;
  for (const c of engine.store.list('IngressClass')) {
    if ((c.spec as { controller?: string } | undefined)?.controller !== NGINX_CONTROLLER) continue;
    names.add(c.metadata.name);
    if (c.metadata.annotations?.['ingressclass.kubernetes.io/is-default-class'] === 'true') hasDefault = true;
  }
  return { names, hasDefault };
}

export function nginxIngresses(engine: Engine): Ingress[] {
  const { names, hasDefault } = nginxClasses(engine);
  return engine.store.list<Ingress>('Ingress').filter((i) => (i.spec.ingressClassName !== undefined ? names.has(i.spec.ingressClassName) : hasDefault));
}

export function routeIngress(engine: Engine, req: ProxyRequest): ProxyResult {
  const ingresses = nginxIngresses(engine);
  let cert: CertInfo | undefined;
  let tlsHost = false;
  for (const ing of ingresses) for (const t of ing.spec.tls ?? []) {
    if (!(t.hosts ?? []).some((h) => hostMatches(h, req.host))) continue;
    tlsHost = true;
    cert = cert ?? tlsSecretCert(engine, ing.metadata.namespace, t.secretName);
  }
  if (req.tls) cert = cert ?? FAKE_CERT;
  let best: { ing: Ingress; backend: IngressBackend; score: number } | undefined;
  for (const ing of ingresses) {
    for (const rule of ing.spec.rules ?? []) {
      if (!hostMatches(rule.host, req.host)) continue;
      for (const p of rule.http?.paths ?? []) {
        const pattern = p.path ?? '/';
        if (!pathMatches(p.pathType, pattern, req.path)) continue;
        const score = (rule.host ? (rule.host.startsWith('*.') ? 1000 : 2000) : 0) + (p.pathType === 'Exact' ? 500 : 0) + pattern.length;
        if (!best || score > best.score) best = { ing, backend: p.backend, score };
      }
    }
    if (!best && ing.spec.defaultBackend && !(ing.spec.rules ?? []).length) best = { ing, backend: ing.spec.defaultBackend, score: -1 };
  }
  if (!best) return { kind: 'response', status: 404, body: nginxPage(404, 'Not Found'), cert };
  // ssl-redirect (default true): plain HTTP to a host with TLS configured is redirected
  if (!req.tls && tlsHost && best.ing.metadata.annotations?.['nginx.ingress.kubernetes.io/ssl-redirect'] !== 'false') {
    return { kind: 'response', status: 308, body: nginxPage(308, 'Permanent Redirect'), location: `https://${req.host}${req.path}` };
  }
  const svc = best.backend.service ? engine.store.get<Service>('Service', best.ing.metadata.namespace, best.backend.service.name) : undefined;
  const target = svc ? pickBackend(engine, svc, best.backend.service?.port) : undefined;
  if (!target) return { kind: 'response', status: 503, body: nginxPage(503, 'Service Temporarily Unavailable'), cert };
  const rewrite = best.ing.metadata.annotations?.['nginx.ingress.kubernetes.io/rewrite-target'];
  return { kind: 'forward', pod: target.pod, port: target.port, path: rewrite !== undefined && !rewrite.includes('$') ? rewrite : req.path, cert };
}

// ---------------------------------------------------------------------------
// Gateway API (Envoy Gateway)
// ---------------------------------------------------------------------------

export interface GwListener { name: string; port: number; protocol: string; hostname?: string; tls?: { mode?: string; certificateRefs?: { name: string; namespace?: string; kind?: string }[] }; allowedRoutes?: { namespaces?: { from?: string; selector?: Record<string, unknown> } } }
export interface RouteRule {
  matches?: { path?: { type?: string; value?: string }; headers?: { name: string; value: string }[]; method?: string }[];
  backendRefs?: { name: string; port?: number; weight?: number; kind?: string; namespace?: string; group?: string }[];
  filters?: { type: string; requestRedirect?: { scheme?: string; statusCode?: number; hostname?: string }; urlRewrite?: { path?: { type?: string; replacePrefixMatch?: string; replaceFullPath?: string } } }[];
}
export interface RouteSpec { parentRefs?: { name: string; namespace?: string; sectionName?: string; port?: number; kind?: string }[]; hostnames?: string[]; rules?: RouteRule[] }

export function gatewayListeners(gw: KubeObject): GwListener[] {
  return ((gw.spec as { listeners?: GwListener[] } | undefined)?.listeners ?? []);
}

/** Envoy Gateway maps privileged listener ports to container ports +10000. */
export function envoyContainerPort(port: number): number {
  return port < 1024 ? port + 10000 : port;
}

export function listenerCert(engine: Engine, gw: KubeObject, l: GwListener): CertInfo | undefined {
  const ref = l.tls?.certificateRefs?.[0];
  return ref ? tlsSecretCert(engine, ref.namespace ?? gw.metadata.namespace, ref.name) : undefined;
}

/** A listener is served only when it is valid (HTTPS listeners need a resolvable certificate). */
export function listenerProgrammed(engine: Engine, gw: KubeObject, l: GwListener): boolean {
  if (l.protocol === 'HTTP') return true;
  if (l.protocol === 'HTTPS') return (l.tls?.mode ?? 'Terminate') === 'Terminate' && !!listenerCert(engine, gw, l);
  return false;
}

function listenerAllows(engine: Engine, gw: KubeObject, l: GwListener, route: KubeObject): boolean {
  const from = l.allowedRoutes?.namespaces?.from ?? 'Same';
  if (from === 'All') return true;
  if (from === 'Selector') {
    const ns = engine.store.get<Namespace>('Namespace', undefined, route.metadata.namespace as string);
    return matches(fromLabelSelector(l.allowedRoutes?.namespaces?.selector as never), ns?.metadata.labels);
  }
  return route.metadata.namespace === gw.metadata.namespace;
}

function hostnamesIntersect(listener: string | undefined, route: string[] | undefined): boolean {
  if (!listener || !route?.length) return true;
  return route.some((h) => hostMatches(listener, h) || hostMatches(h, listener));
}

export type AttachResult = { ok: true; listeners: GwListener[] } | { ok: false; reason: 'NoMatchingParent' | 'NotAllowedByListeners' | 'NoMatchingListenerHostname' };

/** Which listeners of a Gateway an HTTPRoute attaches to through one parentRef (GEP-1364 status reasons). */
export function attach(engine: Engine, gw: KubeObject, route: KubeObject, ref: { sectionName?: string; port?: number }): AttachResult {
  const spec = (route.spec ?? {}) as RouteSpec;
  let ls = gatewayListeners(gw).filter((l) => (!ref.sectionName || l.name === ref.sectionName) && (ref.port === undefined || l.port === ref.port));
  if (!ls.length) return { ok: false, reason: 'NoMatchingParent' };
  ls = ls.filter((l) => listenerAllows(engine, gw, l, route));
  if (!ls.length) return { ok: false, reason: 'NotAllowedByListeners' };
  ls = ls.filter((l) => hostnamesIntersect(l.hostname, spec.hostnames));
  if (!ls.length) return { ok: false, reason: 'NoMatchingListenerHostname' };
  return { ok: true, listeners: ls };
}

export function routesOf(engine: Engine, gw: KubeObject): KubeObject[] {
  return engine.store.list('HTTPRoute').filter((r) => ((r.spec as RouteSpec | undefined)?.parentRefs ?? []).some((p) => (p.kind ?? 'Gateway') === 'Gateway' && p.name === gw.metadata.name && (p.namespace ?? r.metadata.namespace) === gw.metadata.namespace));
}

export function routeGateway(engine: Engine, gw: KubeObject, req: ProxyRequest): ProxyResult {
  const listener = gatewayListeners(gw).find((l) => envoyContainerPort(l.port) === req.port && listenerProgrammed(engine, gw, l) && hostMatches(l.hostname, req.host))
    ?? gatewayListeners(gw).find((l) => envoyContainerPort(l.port) === req.port && listenerProgrammed(engine, gw, l) && req.tls);
  if (!listener) return { kind: 'refused' };
  const https = listener.protocol === 'HTTPS';
  if (https !== req.tls) return https ? { kind: 'response', status: 400, body: 'Client sent an HTTP request to an HTTPS server.\n' } : { kind: 'refused' };
  const cert = https ? listenerCert(engine, gw, listener) : undefined;
  if (!hostMatches(listener.hostname, req.host)) return { kind: 'response', status: 404, body: '', cert };
  let best: { route: KubeObject; rule: RouteRule; score: number; prefix: string } | undefined;
  for (const route of routesOf(engine, gw)) {
    const spec = (route.spec ?? {}) as RouteSpec;
    const refs = (spec.parentRefs ?? []).filter((p) => p.name === gw.metadata.name && (p.namespace ?? route.metadata.namespace) === gw.metadata.namespace);
    if (!refs.some((p) => { const a = attach(engine, gw, route, p); return a.ok && a.listeners.includes(listener); })) continue;
    if (spec.hostnames?.length && !spec.hostnames.some((h) => hostMatches(h, req.host))) continue;
    for (const rule of spec.rules ?? []) {
      for (const m of rule.matches?.length ? rule.matches : [{}]) {
        const type = m.path?.type ?? 'PathPrefix', value = m.path?.value ?? '/';
        if (m.headers?.length || m.method) continue; // header/method matches need request data the simulator does not model
        if (!pathMatches(type === 'Exact' ? 'Exact' : 'Prefix', value, req.path)) continue;
        const score = (type === 'Exact' ? 10000 : 0) + value.length;
        if (!best || score > best.score) best = { route, rule, score, prefix: value };
      }
    }
  }
  if (!best) return { kind: 'response', status: 404, body: '', cert };
  let path = req.path;
  for (const f of best.rule.filters ?? []) {
    if (f.type === 'RequestRedirect' && f.requestRedirect) {
      const scheme = f.requestRedirect.scheme ?? (req.tls ? 'https' : 'http');
      return { kind: 'response', status: f.requestRedirect.statusCode ?? 302, body: '', location: `${scheme}://${f.requestRedirect.hostname ?? req.host}${req.path}`, cert };
    }
    if (f.type === 'URLRewrite' && f.urlRewrite?.path) {
      const rp = f.urlRewrite.path;
      if (rp.replaceFullPath !== undefined) path = rp.replaceFullPath;
      else if (rp.replacePrefixMatch !== undefined) path = (rp.replacePrefixMatch.replace(/\/$/, '') + req.path.slice(best.prefix.replace(/\/$/, '').length)) || '/';
    }
  }
  const refs = (best.rule.backendRefs ?? []).filter((b) => (b.weight ?? 1) > 0);
  if (!refs.length) return { kind: 'response', status: 500, body: '', cert };
  // weighted pick (backendRefs[].weight) — this is how a canary is split
  const total = refs.reduce((n, b) => n + (b.weight ?? 1), 0);
  let roll = engine.rng.next() * total;
  let chosen = refs[0] as NonNullable<RouteRule['backendRefs']>[number];
  for (const b of refs) { roll -= b.weight ?? 1; if (roll < 0) { chosen = b; break; } }
  const svc = (chosen.kind ?? 'Service') === 'Service' && (chosen.namespace ?? best.route.metadata.namespace) === best.route.metadata.namespace ? engine.store.get<Service>('Service', best.route.metadata.namespace, chosen.name) : undefined;
  if (!svc || !(svc.spec.ports ?? []).some((p) => p.port === chosen.port)) return { kind: 'response', status: 500, body: '', cert };
  const target = pickBackend(engine, svc, { number: chosen.port });
  if (!target) return { kind: 'response', status: 503, body: 'no healthy upstream', cert };
  return { kind: 'forward', pod: target.pod, port: target.port, path, cert };
}

/** The Gateway a proxy pod belongs to (Envoy Gateway labels its infrastructure with the owning Gateway). */
export function gatewayOfProxy(engine: Engine, pod: Pod): KubeObject | undefined {
  const name = pod.metadata.labels?.['gateway.envoyproxy.io/owning-gateway-name'];
  const ns = pod.metadata.labels?.['gateway.envoyproxy.io/owning-gateway-namespace'];
  return name && ns ? engine.store.get('Gateway', ns, name) : undefined;
}

void ((0 as unknown) as Peer);
