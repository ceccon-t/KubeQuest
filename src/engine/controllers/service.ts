/** Service controller (IP allocation, LB provisioning) and Endpoints/EndpointSlice controller. */
import type { Engine } from '../engine.ts';
import type { Service, Pod, Endpoints, KubeObject } from '../types.ts';
import { matches, type Requirement } from '../selector.ts';
import { isPodReady } from './kubelet.ts';

const LB_PROVISION_MS = 6000;

export function serviceSelectorReqs(svc: Service): Requirement[] {
  return Object.entries(svc.spec.selector ?? {}).map(([k, v]) => ({ key: k, op: 'in', values: [v] }));
}

export function runServiceController(engine: Engine): void {
  const now = engine.clock.nowMs;
  for (const svc of engine.store.list<Service>('Service')) {
    let changed = false;
    const type = svc.spec.type ?? 'ClusterIP';
    if (type !== 'ExternalName' && !svc.spec.clusterIP) {
      svc.spec.clusterIP = engine.allocateClusterIp();
      svc.spec.clusterIPs = [svc.spec.clusterIP];
      changed = true;
    }
    if (type === 'NodePort' || type === 'LoadBalancer') {
      for (const p of svc.spec.ports ?? []) if (!p.nodePort) { p.nodePort = engine.allocateNodePort(); changed = true; }
    }
    if (type === 'LoadBalancer') {
      const created = Date.parse(svc.metadata.creationTimestamp ?? '');
      const lb = (svc.status.loadBalancer ??= {});
      if (!lb.ingress && now - created >= LB_PROVISION_MS) {
        const n = (engine.ticks % 200) + 10;
        lb.ingress = [{ ip: `203.0.113.${n}` }];
        engine.store.event({ type: 'Normal', reason: 'EnsuredLoadBalancer', message: 'Ensured load balancer', involved: svc, component: 'service-controller' });
        changed = true;
      }
    }
    if (changed) engine.store.update(svc);
  }
}

/** Ready, non-terminating pods selected by the service. */
export function serviceBackends(engine: Engine, svc: Service): { ready: Pod[]; notReady: Pod[] } {
  const ready: Pod[] = [], notReady: Pod[] = [];
  if (!svc.spec.selector || Object.keys(svc.spec.selector).length === 0) return { ready, notReady };
  const reqs = serviceSelectorReqs(svc);
  for (const p of engine.store.list<Pod>('Pod', svc.metadata.namespace)) {
    if (!matches(reqs, p.metadata.labels)) continue;
    if (p.metadata.deletionTimestamp) continue; // terminating pods leave endpoints immediately
    if (!p.status.podIP) continue;
    if (p.status.phase === 'Succeeded' || p.status.phase === 'Failed') continue;
    if (isPodReady(p) || svc.spec.publishNotReadyAddresses) ready.push(p);
    else notReady.push(p);
  }
  return { ready, notReady };
}

export function resolveTargetPort(svc: Service, port: { targetPort?: number | string; port: number }, pod?: Pod): number {
  const tp = port.targetPort ?? port.port;
  if (typeof tp === 'number') return tp;
  if (/^\d+$/.test(tp)) return parseInt(tp, 10);
  for (const c of pod?.spec.containers ?? []) for (const cp of c.ports ?? []) if (cp.name === tp) return cp.containerPort;
  return -1;
}

export function runEndpointsController(engine: Engine): void {
  for (const svc of engine.store.list<Service>('Service')) {
    if (!svc.spec.selector || (svc.spec.type ?? 'ClusterIP') === 'ExternalName') continue;
    const { ready, notReady } = serviceBackends(engine, svc);
    const addr = (p: Pod) => ({ ip: p.status.podIP as string, nodeName: p.spec.nodeName, targetRef: { kind: 'Pod', namespace: p.metadata.namespace as string, name: p.metadata.name, uid: p.metadata.uid } });
    const ports = (svc.spec.ports ?? []).map((pt) => ({ ...(pt.name ? { name: pt.name } : {}), port: resolveTargetPort(svc, pt, ready[0] ?? notReady[0]), protocol: pt.protocol ?? 'TCP' }));
    const subsets: NonNullable<Endpoints['subsets']> = [];
    if (ready.length || notReady.length) {
      const s: NonNullable<Endpoints['subsets']>[number] = { ports };
      if (ready.length) s.addresses = ready.map(addr);
      if (notReady.length) s.notReadyAddresses = notReady.map(addr);
      subsets.push(s);
    }
    const existing = engine.store.get<Endpoints>('Endpoints', svc.metadata.namespace, svc.metadata.name);
    const desired: Endpoints = {
      apiVersion: 'v1',
      kind: 'Endpoints',
      metadata: { name: svc.metadata.name, namespace: svc.metadata.namespace, labels: { ...(svc.metadata.labels ?? {}) }, ...(subsets.length ? {} : {}) },
      ...(subsets.length ? { subsets } : {}),
    };
    if (!existing) {
      engine.store.create(desired);
    } else if (JSON.stringify(existing.subsets ?? null) !== JSON.stringify(desired.subsets ?? null)) {
      if (desired.subsets) existing.subsets = desired.subsets;
      else delete existing.subsets;
      engine.store.update(existing);
    }
    // EndpointSlice mirror (one slice per service)
    syncSlice(engine, svc, ready, notReady, ports);
  }
  // remove endpoints of deleted services
  for (const ep of engine.store.list<Endpoints>('Endpoints')) {
    if (!engine.store.get('Service', ep.metadata.namespace, ep.metadata.name)) engine.store.remove(ep);
  }
  for (const es of engine.store.list('EndpointSlice')) {
    const svcName = es.metadata.labels?.['kubernetes.io/service-name'];
    if (!svcName || !engine.store.get('Service', es.metadata.namespace, svcName)) engine.store.remove(es);
  }
}

function syncSlice(engine: Engine, svc: Service, ready: Pod[], notReady: Pod[], ports: { name?: string; port: number; protocol: string }[]): void {
  const sliceName = `${svc.metadata.name}-${engine.rng.hash(svc.metadata.uid ?? svc.metadata.name).slice(0, 5)}`;
  const ep = (p: Pod, r: boolean) => ({ addresses: [p.status.podIP as string], conditions: { ready: r, serving: r, terminating: false }, nodeName: p.spec.nodeName, targetRef: { kind: 'Pod', name: p.metadata.name, namespace: p.metadata.namespace, uid: p.metadata.uid } });
  const endpoints = [...ready.map((p) => ep(p, true)), ...notReady.map((p) => ep(p, false))];
  const desired: KubeObject = {
    apiVersion: 'discovery.k8s.io/v1',
    kind: 'EndpointSlice',
    metadata: { name: sliceName, namespace: svc.metadata.namespace, labels: { 'endpointslice.kubernetes.io/managed-by': 'endpointslice-controller.k8s.io', 'kubernetes.io/service-name': svc.metadata.name }, ownerReferences: [engine.store.ownerRef(svc)] },
    addressType: 'IPv4',
    endpoints,
    ports: ports.map((p) => ({ ...p })),
  };
  const existing = engine.store.get('EndpointSlice', svc.metadata.namespace, sliceName);
  if (!existing) engine.store.create(desired);
  else if (JSON.stringify(existing.endpoints) !== JSON.stringify(endpoints) || JSON.stringify(existing.ports) !== JSON.stringify(desired.ports)) {
    existing.endpoints = endpoints;
    existing.ports = desired.ports;
    engine.store.update(existing);
  }
}

/** Cluster DNS lookup: `name`, `name.ns`, `name.ns.svc`, `name.ns.svc.cluster.local`. */
export function resolveDns(engine: Engine, host: string, fromNamespace: string): { ip: string; svc: Service } | undefined {
  const h = host.replace(/\.$/, '');
  const parts = h.split('.');
  let name: string | undefined, ns: string | undefined;
  if (parts.length === 1) { name = parts[0]; ns = fromNamespace; }
  else if (parts.length === 2) { name = parts[0]; ns = parts[1]; }
  else if (parts.length >= 3 && parts[2] === 'svc' && (parts.length === 3 || parts.slice(3).join('.') === 'cluster.local')) { name = parts[0]; ns = parts[1]; }
  if (!name || !ns) return undefined;
  const svc = engine.store.get<Service>('Service', ns, name);
  if (!svc || !svc.spec.clusterIP || svc.spec.clusterIP === 'None') return undefined;
  return { ip: svc.spec.clusterIP, svc };
}
