/**
 * Status and infrastructure managed by the L7 controllers the simulator ships: ingress-nginx (Ingress status)
 * and Envoy Gateway (GatewayClass/Gateway/HTTPRoute status + the per-Gateway proxy Deployment and Service).
 * They only act while their controller pod is running, exactly like the real thing.
 */
import type { Engine } from '../engine.ts';
import type { KubeObject, Pod, Service, Ingress, Condition, Deployment } from '../types.ts';
import { isPodReady } from './kubelet.ts';
import { matches } from '../selector.ts';
import { serviceSelectorReqs } from './service.ts';
import { nginxIngresses, gatewayListeners, listenerProgrammed, listenerCert, attach, routesOf, envoyContainerPort, ENVOY_CONTROLLER, GW_GROUP, type RouteSpec } from '../routing.ts';
import { applyDefaults } from '../defaults.ts';
import { sha256hex } from '../encoding.ts';

const NGINX_SYNC_MS = 10_000;
export const ENVOY_NS = 'envoy-gateway-system';
export const ENVOY_PROXY_IMAGE = 'docker.io/envoyproxy/envoy:distroless-v1.32.3';

/** A ready pod whose container runs a controller of the given kind (image behaviour `controller`). */
function running(engine: Engine, name: string): Pod | undefined {
  for (const p of engine.store.list<Pod>('Pod')) {
    if (p.metadata.deletionTimestamp || !isPodReady(p)) continue;
    if (engine.podRuntime(p).containers.some((c) => c.behaviour?.controller === name || c.behaviour?.proxy === name)) return p;
  }
  return undefined;
}

function runNginx(engine: Engine): void {
  const ingresses = nginxIngresses(engine);
  if (!ingresses.length) return;
  const pod = running(engine, 'ingress-nginx');
  if (!pod) return;
  // --publish-service: the LoadBalancer Service in front of the controller
  const svc = engine.store.list<Service>('Service', pod.metadata.namespace).find((s) => s.spec.type === 'LoadBalancer' && matches(serviceSelectorReqs(s), pod.metadata.labels));
  const ip = svc?.status.loadBalancer?.ingress?.[0]?.ip;
  const now = engine.clock.nowMs;
  for (const ing of ingresses) {
    const key = `nginx-sync:${ing.metadata.uid}:${ing.metadata.generation ?? 0}`;
    if (!engine.scratch.has(key)) {
      engine.scratch.set(key, now);
      engine.store.event({ type: 'Normal', reason: 'Sync', message: 'Scheduled for sync', involved: ing, component: 'nginx-ingress-controller' });
    }
    const have = ing.status?.loadBalancer?.ingress?.[0]?.ip;
    if (ip && have !== ip && now - (engine.scratch.get(key) as number) >= NGINX_SYNC_MS) {
      ing.status = { loadBalancer: { ingress: [{ ip }] } };
      engine.store.update(ing);
    }
  }
}

function setStatus(engine: Engine, obj: KubeObject, status: Record<string, unknown>): void {
  if (JSON.stringify(obj.status ?? null) === JSON.stringify(status)) return;
  obj.status = status;
  engine.store.update(obj);
}

function infraName(gw: KubeObject): string {
  return `envoy-${gw.metadata.namespace}-${gw.metadata.name}-${sha256hex(`${gw.metadata.namespace}/${gw.metadata.name}`).slice(0, 8)}`;
}

function runEnvoyGateway(engine: Engine): void {
  const classes = engine.store.list('GatewayClass').filter((c) => (c.spec as { controllerName?: string } | undefined)?.controllerName === ENVOY_CONTROLLER);
  const gateways = engine.store.list('Gateway');
  const infra = engine.store.list<Deployment>('Deployment', ENVOY_NS).filter((d) => d.metadata.labels?.['app.kubernetes.io/managed-by'] === 'envoy-gateway');
  if (!classes.length && !gateways.length && !infra.length) return;
  const controller = running(engine, 'envoy-gateway');
  if (!controller) return;
  const t = engine.clock.iso();
  const cond = (prev: Condition[] | undefined, type: string, ok: boolean, reason: string, message: string, generation?: number): Condition => {
    const p = prev?.find((c) => c.type === type);
    const status = ok ? 'True' : 'False';
    return { type, status, reason, message, lastTransitionTime: p && p.status === status ? p.lastTransitionTime : t, ...(generation !== undefined ? { observedGeneration: generation } : {}) } as Condition;
  };
  for (const gc of classes) setStatus(engine, gc, { conditions: [cond((gc.status as { conditions?: Condition[] } | undefined)?.conditions, 'Accepted', true, 'Accepted', 'Valid GatewayClass', gc.metadata.generation)] });
  const classNames = new Set(classes.map((c) => c.metadata.name));
  const wanted = new Set<string>();
  for (const gw of gateways) {
    if (!classNames.has(String((gw.spec as { gatewayClassName?: string } | undefined)?.gatewayClassName))) continue;
    const name = infraName(gw);
    wanted.add(name);
    const labels = { 'app.kubernetes.io/component': 'proxy', 'app.kubernetes.io/managed-by': 'envoy-gateway', 'app.kubernetes.io/name': 'envoy', 'gateway.envoyproxy.io/owning-gateway-name': gw.metadata.name, 'gateway.envoyproxy.io/owning-gateway-namespace': gw.metadata.namespace as string };
    const listeners = gatewayListeners(gw);
    const ports = [...new Set(listeners.filter((l) => listenerProgrammed(engine, gw, l)).map((l) => l.port))].map((p) => ({ name: `${p === 443 ? 'https' : 'http'}-${p}`, port: p, protocol: 'TCP', targetPort: envoyContainerPort(p) }));
    engine.ensureNamespace(ENVOY_NS);
    if (!engine.store.get('Deployment', ENVOY_NS, name)) {
      engine.store.create(applyDefaults({ apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name, namespace: ENVOY_NS, labels }, spec: { replicas: 1, selector: { matchLabels: labels }, template: { metadata: { labels }, spec: { containers: [{ name: 'envoy', image: ENVOY_PROXY_IMAGE, ports: [{ containerPort: 19001, name: 'metrics', protocol: 'TCP' }] }] } } }, status: {} } as KubeObject, engine));
    }
    let svc = engine.store.get<Service>('Service', ENVOY_NS, name);
    if (!svc && ports.length) {
      svc = engine.store.create(applyDefaults({ apiVersion: 'v1', kind: 'Service', metadata: { name, namespace: ENVOY_NS, labels }, spec: { type: 'LoadBalancer', selector: labels, ports }, status: { loadBalancer: {} } } as KubeObject, engine)) as unknown as Service;
    } else if (svc && JSON.stringify((svc.spec.ports ?? []).map((p) => p.port)) !== JSON.stringify(ports.map((p) => p.port))) {
      svc.spec.ports = ports.map((p) => ({ ...p, nodePort: svc?.spec.ports?.find((x) => x.port === p.port)?.nodePort }));
      engine.store.update(svc, { specChanged: true });
    }
    const ip = svc?.status.loadBalancer?.ingress?.[0]?.ip;
    const proxies = engine.store.list<Pod>('Pod', ENVOY_NS).filter((p) => p.metadata.labels?.['gateway.envoyproxy.io/owning-gateway-name'] === gw.metadata.name && p.metadata.labels?.['gateway.envoyproxy.io/owning-gateway-namespace'] === gw.metadata.namespace && !p.metadata.deletionTimestamp);
    const readyProxies = proxies.filter(isPodReady).length;
    const prev = gw.status as { conditions?: Condition[]; listeners?: { name: string; conditions?: Condition[] }[] } | undefined;
    const routes = routesOf(engine, gw);
    const listenerStatus = listeners.map((l) => {
      const p = prev?.listeners?.find((x) => x.name === l.name)?.conditions;
      const ok = listenerProgrammed(engine, gw, l);
      const certMissing = l.protocol === 'HTTPS' && !listenerCert(engine, gw, l);
      const ref = l.tls?.certificateRefs?.[0];
      return {
        attachedRoutes: routes.filter((r) => ((r.spec as RouteSpec).parentRefs ?? []).some((pr) => { const a = attach(engine, gw, r, pr); return a.ok && a.listeners.some((x) => x.name === l.name); })).length,
        conditions: [
          cond(p, 'Programmed', ok, ok ? 'Programmed' : 'Invalid', ok ? 'Sending translated listener configuration to the data plane' : 'Listener is invalid, see other Conditions for details.', gw.metadata.generation),
          cond(p, 'Accepted', true, 'Accepted', 'Listener has been successfully translated', gw.metadata.generation),
          certMissing ? cond(p, 'ResolvedRefs', false, 'InvalidCertificateRef', ref ? `Secret ${ref.namespace ?? gw.metadata.namespace}/${ref.name} does not exist.` : 'Listener must have TLS set when protocol is HTTPS.', gw.metadata.generation) : cond(p, 'ResolvedRefs', true, 'ResolvedRefs', 'Listener references have been resolved', gw.metadata.generation),
        ],
        name: l.name,
        supportedKinds: [{ group: GW_GROUP, kind: 'HTTPRoute' }, { group: GW_GROUP, kind: 'GRPCRoute' }],
      };
    });
    const programmed = !!ip && readyProxies > 0;
    setStatus(engine, gw, {
      ...(ip ? { addresses: [{ type: 'IPAddress', value: ip }] } : {}),
      conditions: [
        cond(prev?.conditions, 'Accepted', true, 'Accepted', 'The Gateway has been scheduled by Envoy Gateway', gw.metadata.generation),
        programmed ? cond(prev?.conditions, 'Programmed', true, 'Programmed', `Address assigned to the Gateway, ${readyProxies}/${proxies.length} envoy Deployment replicas available`, gw.metadata.generation) : cond(prev?.conditions, 'Programmed', false, 'AddressNotAssigned', 'No addresses have been assigned to the Gateway', gw.metadata.generation),
      ],
      listeners: listenerStatus,
    });
  }
  // tear down proxies of deleted Gateways (owner references cannot cross namespaces)
  for (const d of infra) if (!wanted.has(d.metadata.name)) { engine.store.remove(d); const s = engine.store.get('Service', ENVOY_NS, d.metadata.name); if (s) engine.store.remove(s); }
  // HTTPRoute status
  for (const route of engine.store.list('HTTPRoute')) {
    const spec = (route.spec ?? {}) as RouteSpec;
    const prev = (route.status as { parents?: { parentRef: { name: string }; conditions?: Condition[] }[] } | undefined)?.parents;
    const parents: unknown[] = [];
    for (const ref of spec.parentRefs ?? []) {
      const gw = (ref.kind ?? 'Gateway') === 'Gateway' ? engine.store.get('Gateway', ref.namespace ?? route.metadata.namespace, ref.name) : undefined;
      if (!gw || !classNames.has(String((gw.spec as { gatewayClassName?: string }).gatewayClassName))) continue;
      const p = prev?.find((x) => x.parentRef.name === ref.name)?.conditions;
      const a = attach(engine, gw, route, ref);
      let missing: string | undefined;
      for (const rule of spec.rules ?? []) for (const b of rule.backendRefs ?? []) {
        const svc = engine.store.get<Service>('Service', b.namespace ?? route.metadata.namespace, b.name);
        if (b.namespace && b.namespace !== route.metadata.namespace) missing = missing ?? `Backend ref to Service ${b.namespace}/${b.name} not permitted by any ReferenceGrant.`;
        else if (!svc) missing = missing ?? `Service ${route.metadata.namespace}/${b.name} not found`;
        else if (!(svc.spec.ports ?? []).some((sp) => sp.port === b.port)) missing = missing ?? `TCP Port ${b.port} not found on Service ${route.metadata.namespace}/${b.name}`;
      }
      const notAccepted: Record<string, string> = { NoMatchingParent: 'No listeners match this parent ref', NotAllowedByListeners: 'No listeners included by this parent ref allowed this attachment.', NoMatchingListenerHostname: "There were no hostname intersections between the HTTPRoute and this parent ref's Listener(s)." };
      parents.push({
        conditions: [
          a.ok ? cond(p, 'Accepted', true, 'Accepted', 'Route is accepted', route.metadata.generation) : cond(p, 'Accepted', false, a.reason, notAccepted[a.reason] as string, route.metadata.generation),
          missing ? cond(p, 'ResolvedRefs', false, missing.includes('ReferenceGrant') ? 'RefNotPermitted' : missing.includes('Port') ? 'PortNotFound' : 'BackendNotFound', missing, route.metadata.generation) : cond(p, 'ResolvedRefs', true, 'ResolvedRefs', 'Resolved all the Object references for the Route', route.metadata.generation),
        ],
        controllerName: ENVOY_CONTROLLER,
        parentRef: { group: GW_GROUP, kind: 'Gateway', name: ref.name, ...(ref.namespace ? { namespace: ref.namespace } : {}), ...(ref.sectionName ? { sectionName: ref.sectionName } : {}) },
      });
    }
    if (parents.length || route.status) setStatus(engine, route, { parents });
  }
}

export function runIngressControllers(engine: Engine): void {
  runNginx(engine);
  runEnvoyGateway(engine);
}

void ((0 as unknown) as Ingress);
