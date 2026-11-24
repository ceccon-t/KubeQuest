/** Chapter 4, second half: L7 routing (Ingress, Gateway API), TLS and NetworkPolicy. */
import type { Mission, ObjectiveContext } from '../game/mission.ts';
import { ORBITAL_IMAGES, REG, deployment, service, pod, orbitalNodes, systemWorkloads, usedCmd, outputHad } from './lib.ts';
import { ingressNginx, envoyGateway, tlsPair } from './platform.ts';
import type { Ingress, KubeObject, NetworkPolicy, Pod, Secret, Condition } from '../engine/types.ts';
import { ingressAllowed, podPeer, EXTERNAL, type Peer } from '../engine/netpol.ts';
import { sha256hex } from '../engine/encoding.ts';

const HOST = 'freight.orbital.example';
const CERT = tlsPair(HOST);
/** Envoy Gateway names a Gateway's proxy Service `envoy-<ns>-<name>-<hash>`. */
const envoySvc = (ns: string, name: string): string => `envoy-gateway-system/envoy-${ns}-${name}-${sha256hex(`${ns}/${name}`).slice(0, 8)}`;

const freightTier = (frontend = `${REG}/frontend:1.6.0`, age = 3 * 86400) => [
  { ageSeconds: age, object: deployment({ name: 'frontend', ns: 'freight', image: frontend, replicas: 2, port: 8080 }) },
  { ageSeconds: age, object: service({ name: 'frontend', ns: 'freight', selector: { app: 'frontend' }, port: 80, targetPort: 8080 }) },
  { ageSeconds: age, object: deployment({ name: 'cargo-api', ns: 'freight', image: `${REG}/cargo-api:2.2.0`, replicas: 2, port: 8080 }) },
  { ageSeconds: age, object: service({ name: 'cargo-api', ns: 'freight', selector: { app: 'cargo-api' }, port: 80, targetPort: 8080 }) },
  { ageSeconds: age + 86400, object: deployment({ name: 'cargo-db', ns: 'freight', image: 'redis:7', replicas: 1, port: 6379, containerName: 'db' }) },
  { ageSeconds: age + 86400, object: service({ name: 'cargo-db', ns: 'freight', selector: { app: 'cargo-db' }, port: 6379 }) },
];

const ingressRoutes = (c: ObjectiveContext, svc: string, path: string): boolean => {
  const ing = c.view.list<Ingress>('Ingress', 'freight').find((i) => i.spec.ingressClassName === 'nginx');
  return !!ing?.spec.rules?.some((r) => r.host === HOST && r.http?.paths.some((p) => (p.path ?? '/').replace(/\/$/, '') === path.replace(/\/$/, '') && p.pathType !== 'Exact' && p.backend.service?.name === svc && p.backend.service.port?.number === 80));
};

export const m4_3: Mission = {
  id: '4.3', chapter: 4, order: 3, title: 'One door, many rooms', tagline: 'Host and path routing behind one load balancer — with TLS.',
  ticket: {
    from: 'Priya (Product)', priority: 'P2', subject: `Customers must reach freight at https://${HOST}`,
    body: [
      `Launch is today and the site has no front door. Publish it at **https://${HOST}**: \`/api\` goes to the cargo-api Service (port 80), everything else to frontend (port 80).`,
      'ingress-nginx is installed (IngressClass `nginx`) behind one LoadBalancer. The certificate from the internal CA is on your workstation: `~/certs/freight.crt` and `~/certs/freight.key`. Store it as a TLS Secret named `freight-tls` in the freight namespace.',
      `Public DNS is not switched yet. Test with \`curl --resolve ${HOST}:443:LB_IP https://${HOST}/\` — the LB address is on the controller's Service.`,
    ],
  },
  concepts: [
    { title: 'Ingress: L7 routing rules', body: 'An **Ingress** maps hosts and paths to Services. It does nothing by itself: an **ingress controller** (here ingress-nginx) watches Ingresses of its **IngressClass** and configures a proxy that sits behind one LoadBalancer. Paths are `Prefix` or `Exact`; the longest matching prefix wins.', example: 'kubectl get ingressclass\nkubectl describe ingress freight -n freight' },
    { title: 'TLS termination', body: '`spec.tls` names the hosts and a Secret of type `kubernetes.io/tls` (`tls.crt`, `tls.key`) in the same namespace. The controller terminates HTTPS and talks plain HTTP to the Pods. If the Secret is missing, ingress-nginx serves its self-signed *Fake Certificate* and clients refuse it.', example: 'kubectl create secret tls freight-tls --cert=certs/freight.crt --key=certs/freight.key -n freight' },
    { title: 'Testing before DNS', body: 'The proxy picks the rule from the `Host` header (and SNI for TLS). `curl --resolve HOST:443:IP` sends the right name to a chosen address; `-H "Host: …"` does the same for plain HTTP. `-k` skips certificate verification — fine for a look, never a fix.', example: `curl --resolve ${HOST}:443:203.0.113.10 https://${HOST}/` },
  ],
  cluster: {
    seed: 53, nodes: orbitalNodes(), namespaces: ['freight'], images: ORBITAL_IMAGES,
    objects: [...systemWorkloads(), ...ingressNginx(), ...freightTier(`${REG}/frontend:1.4.1`)],
    traffic: [{ id: 'customers', service: 'ingress-nginx/ingress-nginx-controller', http: { host: HOST, path: '/', tls: true }, rps: 6, label: 'customers (https)' }, { id: 'cargo', service: 'ingress-nginx/ingress-nginx-controller', http: { host: HOST, path: '/api/cargo', tls: true }, rps: 3, label: 'cargo API' }],
  },
  files: { 'certs/freight.crt': CERT.crt, 'certs/freight.key': CERT.key },
  objectives: [
    { id: 'class', text: 'Find the IngressClass and the address of the ingress controller', check: (c) => usedCmd(c, /^kubectl (get|describe) (ingressclass(es)?)\b/) && c.history.some((h) => /^(kubectl|k) (get|describe) (svc|services?)\b/.test(h.line) && /203\.0\.113\.\d+/.test(h.stdout)) },
    { id: 'secret', text: 'TLS Secret freight-tls exists in freight', check: (c) => c.view.get<Secret>('Secret', 'freight', 'freight-tls')?.type === 'kubernetes.io/tls' },
    { id: 'ingress', text: `Ingress routes ${HOST}: /api → cargo-api, / → frontend`, check: (c) => ingressRoutes(c, 'cargo-api', '/api') && ingressRoutes(c, 'frontend', '/') },
    { id: 'tls', text: 'The Ingress terminates TLS for the host with freight-tls', check: (c) => c.view.list<Ingress>('Ingress', 'freight').some((i) => i.spec.tls?.some((t) => t.secretName === 'freight-tls' && t.hosts?.includes(HOST))) && !!c.view.get('Secret', 'freight', 'freight-tls') },
    { id: 'verify', text: 'curl the site over HTTPS through the load balancer (certificate verified)', check: (c) => c.history.some((h) => /^curl\b/.test(h.line) && !/(^|\s)(-k|--insecure|-[a-zA-Z]*k[a-zA-Z]*)(\s|$)/.test(h.line) && h.expanded.includes(`https://${HOST}`) && h.code === 0 && /freight-frontend|CRG-1042/.test(h.stdout)) },
  ],
  hints: [
    { text: '`kubectl get ingressclass` and `kubectl get svc -n ingress-nginx` (EXTERNAL-IP is the front door). Then create the Secret: `kubectl create secret tls freight-tls --cert=certs/freight.crt --key=certs/freight.key -n freight`.', cost: 100 },
    { text: `An Ingress needs \`ingressClassName: nginx\`, a rule for host \`${HOST}\` with two \`Prefix\` paths (\`/api\` → cargo-api:80, \`/\` → frontend:80) and \`tls: [{hosts: [${HOST}], secretName: freight-tls}]\`.`, cost: 120 },
    { text: `One-liner: \`kubectl create ingress freight -n freight --class=nginx --rule="${HOST}/api*=cargo-api:80,tls=freight-tls" --rule="${HOST}/*=frontend:80,tls=freight-tls"\`. Test: \`curl --resolve ${HOST}:443:LB_IP https://${HOST}/\`.`, cost: 150 },
  ],
  par: { timeSec: 420, commands: 8 }, timeLimitSec: 900, slo: { minAvailability: 0.3 },
  solution: [
    'kubectl get ingressclass',
    'kubectl get svc -n ingress-nginx',
    'kubectl create secret tls freight-tls --cert=certs/freight.crt --key=certs/freight.key -n freight',
    `kubectl create ingress freight -n freight --class=nginx --rule="${HOST}/api*=cargo-api:80,tls=freight-tls" --rule="${HOST}/*=frontend:80,tls=freight-tls"`,
    'sleep 2',
    `curl -s --resolve ${HOST}:443:$(kubectl get svc ingress-nginx-controller -n ingress-nginx -o jsonpath='{.status.loadBalancer.ingress[0].ip}') https://${HOST}/`,
    'kubectl describe ingress freight -n freight',
  ],
  debrief: { proTips: ['cert-manager issues and renews certificates into TLS Secrets automatically — nobody should copy .crt files by hand in production.', 'ingress-nginx redirects HTTP to HTTPS (308) for hosts with TLS; `nginx.ingress.kubernetes.io/ssl-redirect: "false"` turns that off.', 'Annotations are how Ingress grew features (rewrites, auth, rate limits) — and why its successor, the Gateway API, has typed fields instead.'] },
};

const ROUTE_YAML = `apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: frontend
  namespace: freight
spec:
  parentRefs:
  - name: edge
    namespace: gateway-infra
  hostnames:
  - ${HOST}
  rules:
  - matches:
    - path:
        type: PathPrefix
        value: /
    backendRefs:
    - name: frontend
      port: 80
`;

const routeBackends = (c: ObjectiveContext): { name: string; weight: number }[] => {
  const r = c.view.get('HTTPRoute', 'freight', 'frontend');
  const rules = ((r?.spec as { rules?: { backendRefs?: { name: string; weight?: number }[] }[] } | undefined)?.rules) ?? [];
  return (rules[0]?.backendRefs ?? []).map((b) => ({ name: b.name, weight: b.weight ?? 1 }));
};
const routeAccepted = (c: ObjectiveContext): boolean => {
  const parents = ((c.view.get('HTTPRoute', 'freight', 'frontend')?.status as { parents?: { conditions?: Condition[] }[] } | undefined)?.parents) ?? [];
  return parents.some((p) => ['Accepted', 'ResolvedRefs'].every((t) => p.conditions?.some((x) => x.type === t && x.status === 'True')));
};

export const m4_4: Mission = {
  id: '4.4', chapter: 4, order: 4, title: 'Gateway to the future', tagline: 'Gateway API: attach a route, split traffic, promote a canary.',
  ticket: {
    from: 'Release train', priority: 'P2', subject: 'Move freight to the shared Gateway and canary frontend 1.4.1',
    body: [
      'Platform now runs a shared Gateway (`edge`, namespace `gateway-infra`, class `eg` — Envoy Gateway). App teams attach their own HTTPRoutes to it. A starting route is in ~/manifests/httproute.yaml.',
      `Step 1: attach the route so ${HOST} reaches the frontend Service. Step 2: frontend 1.4.1 is already running as Service \`frontend-next\`: send it about 10% of the traffic. Step 3: when the numbers look good, promote it to 100%.`,
      'Customers are on the Gateway address right now and get 404s. Weights live in `backendRefs`.',
    ],
  },
  concepts: [
    { title: 'Three roles, three objects', body: '**GatewayClass**: which implementation (infra provider). **Gateway**: a load balancer with listeners — ports, protocols, TLS, and who may attach (cluster operator). **HTTPRoute**: hostnames, matches and backends (application team), attached with `parentRefs`. Each has its own owner and its own RBAC.', example: 'kubectl get gatewayclass\nkubectl get gateway -A\nkubectl get httproute -n freight' },
    { title: 'Attachment is a handshake', body: 'A route names its Gateway in `parentRefs`; the listener must allow the route\'s namespace (`allowedRoutes.namespaces.from: Same | All | Selector`). The result is reported in the route\'s `status.parents[].conditions`: `Accepted` and `ResolvedRefs`. Read status before testing.', example: "kubectl get httproute frontend -n freight -o jsonpath='{.status.parents[0].conditions}'" },
    { title: 'Weighted backends', body: 'A rule can list several `backendRefs` with `weight`. Traffic is split proportionally: 90 and 10 is a canary, 0 and 100 a cut-over — no annotations, no second proxy. Tools such as Argo Rollouts automate exactly these numbers.', example: 'backendRefs:\n- {name: frontend, port: 80, weight: 90}\n- {name: frontend-next, port: 80, weight: 10}' },
  ],
  cluster: {
    seed: 54, nodes: orbitalNodes(), namespaces: ['freight', 'gateway-infra'], images: ORBITAL_IMAGES,
    objects: [
      ...systemWorkloads(), ...envoyGateway(),
      { ageSeconds: 5 * 86400, object: { apiVersion: 'gateway.networking.k8s.io/v1', kind: 'Gateway', metadata: { name: 'edge', namespace: 'gateway-infra' }, spec: { gatewayClassName: 'eg', listeners: [{ name: 'http', port: 80, protocol: 'HTTP', allowedRoutes: { namespaces: { from: 'All' } } }] } } },
      { ageSeconds: 3 * 86400, object: deployment({ name: 'frontend', ns: 'freight', image: `${REG}/frontend:1.4.0`, replicas: 3, port: 8080, readinessProbe: { httpGet: { path: '/readyz', port: 8080 }, periodSeconds: 5 } }) },
      { ageSeconds: 3 * 86400, object: service({ name: 'frontend', ns: 'freight', selector: { app: 'frontend' }, port: 80, targetPort: 8080 }) },
      { ageSeconds: 1800, object: deployment({ name: 'frontend-next', ns: 'freight', image: `${REG}/frontend:1.4.1`, replicas: 3, port: 8080, readinessProbe: { httpGet: { path: '/readyz', port: 8080 }, periodSeconds: 5 } }) },
      { ageSeconds: 1800, object: service({ name: 'frontend-next', ns: 'freight', selector: { app: 'frontend-next' }, port: 80, targetPort: 8080 }) },
    ],
    traffic: [{ id: 'customers', service: envoySvc('gateway-infra', 'edge'), http: { host: HOST, path: '/' }, rps: 10, label: 'customers' }],
  },
  files: { 'manifests/httproute.yaml': ROUTE_YAML },
  objectives: [
    { id: 'inspect', text: 'Inspect the GatewayClass and the shared Gateway (address, Programmed)', check: (c) => usedCmd(c, /^kubectl (get|describe) (gatewayclass(es)?|gc)\b/) && c.history.some((h) => /^(kubectl|k) (get|describe) (gateways?|gtw)\b/.test(h.line) && /203\.0\.113\.\d+/.test(h.stdout)) },
    { id: 'route', text: 'HTTPRoute frontend is attached to the Gateway and Accepted', check: (c) => routeAccepted(c) && routeBackends(c).some((b) => b.name === 'frontend') },
    { id: 'canary', text: 'About 10% of the traffic goes to frontend-next', check: (c) => { const b = routeBackends(c); const next = b.find((x) => x.name === 'frontend-next')?.weight ?? 0, cur = b.find((x) => x.name === 'frontend')?.weight ?? 0; const share = next / (next + cur || 1); return routeAccepted(c) && share >= 0.05 && share <= 0.2; } },
    { id: 'promote', text: 'Canary is healthy: send 100% to frontend-next', revealAfter: 'canary', check: (c) => { const b = routeBackends(c); const next = b.find((x) => x.name === 'frontend-next')?.weight ?? 0, cur = b.find((x) => x.name === 'frontend')?.weight ?? 0; return c.flags.has('canary-ok') && routeAccepted(c) && next > 0 && cur === 0; } },
    { id: 'curl', text: 'Bonus: curl the Gateway address with the right Host header', optional: true, check: (c) => c.history.some((h) => /^curl\b/.test(h.line) && h.line.includes(HOST) && h.code === 0 && /freight-frontend/.test(h.stdout)) },
  ],
  chaos: [
    { id: 'canary-ok', at: { afterObjective: 'canary', delaySeconds: 20 }, action: { type: 'flag', flag: 'canary-ok' }, announce: { from: 'metrics-bot', text: 'frontend-next: 0 errors in the last 200 canary requests, p95 latency unchanged. Safe to promote.' } },
  ],
  hints: [
    { text: '`kubectl get gatewayclass`, `kubectl get gateway -A` (ADDRESS, PROGRAMMED). Then `kubectl apply -f manifests/httproute.yaml` and check `kubectl describe httproute frontend -n freight` — the Status section says whether the parent accepted it.', cost: 100 },
    { text: 'Edit manifests/httproute.yaml: under `backendRefs` give `frontend` a `weight: 90` and add `- name: frontend-next`, `port: 80`, `weight: 10`. Apply again.', cost: 120 },
    { text: 'When metrics-bot says the canary is healthy, set the weights to `0` and `100` (or remove the old backend) and apply. Nothing restarts: the proxy just routes differently.', cost: 150 },
  ],
  par: { timeSec: 420, commands: 9 }, timeLimitSec: 900, slo: { minAvailability: 0.4 },
  solution: [
    'kubectl get gatewayclass',
    'kubectl get gateway -A',
    'kubectl apply -f manifests/httproute.yaml',
    'sleep 2',
    'kubectl describe httproute frontend -n freight',
    `curl -s -H "Host: ${HOST}" http://$(kubectl get gateway edge -n gateway-infra -o jsonpath='{.status.addresses[0].value}')/`,
    { edit: 'manifests/httproute.yaml', replace: ['    - name: frontend\n      port: 80\n', '    - name: frontend\n      port: 80\n      weight: 90\n    - name: frontend-next\n      port: 80\n      weight: 10\n'] },
    'kubectl apply -f manifests/httproute.yaml',
    'sleep 24',
    { edit: 'manifests/httproute.yaml', replace: ['      weight: 90\n    - name: frontend-next\n      port: 80\n      weight: 10\n', '      weight: 0\n    - name: frontend-next\n      port: 80\n      weight: 100\n'] },
    'kubectl apply -f manifests/httproute.yaml',
  ],
  debrief: { proTips: ['`ReferenceGrant` lets a route in one namespace use a backend in another — cross-namespace references are denied by default.', 'Gateway API also has GRPCRoute, TLSRoute and policy attachment; implementations differ in what they support, so read the conformance report.', 'Argo Rollouts and Flagger drive these weights from metrics: the canary you just did by hand, automated with rollback.'] },
};

const NP = (name: string, selector: Record<string, string>, port: number, from?: string): string => `apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: ${name}
  namespace: freight
spec:
  podSelector:
    matchLabels:
${Object.entries(selector).map(([k, v]) => `      ${k}: ${v}`).join('\n')}
  policyTypes:
  - Ingress
  ingress:
  - ${from ?? `ports:\n    - protocol: TCP\n      port: ${port}`}
`;

/** The connectivity the ticket asks for, evaluated with the engine's NetworkPolicy semantics. */
function tierMatrix(c: ObjectiveContext, edge: Peer | 'external'): boolean {
  const one = (sel: string): Pod | undefined => c.view.readyPods('freight', sel)[0];
  const fe = one('app=frontend'), api = one('app=cargo-api'), db = one('app=cargo-db'), tools = c.view.pod('freight', 'tools');
  if (!fe || !api || !db || !tools) return false;
  const e = c.engine;
  const front = edge === 'external' ? ingressAllowed(e, EXTERNAL, fe, 8080) : ingressAllowed(e, edge, fe, 8080) && !ingressAllowed(e, EXTERNAL, fe, 8080);
  return front && ingressAllowed(e, podPeer(fe), api, 8080) && ingressAllowed(e, podPeer(api), db, 6379)
    && !ingressAllowed(e, podPeer(tools), db, 6379) && !ingressAllowed(e, podPeer(tools), api, 8080) && !ingressAllowed(e, podPeer(fe), db, 6379);
}
const defaultDeny = (c: ObjectiveContext): boolean => c.view.list<NetworkPolicy>('NetworkPolicy', 'freight').some((n) => !Object.keys(n.spec.podSelector?.matchLabels ?? {}).length && !(n.spec.podSelector?.matchExpressions ?? []).length && (n.spec.policyTypes ?? []).includes('Ingress') && !(n.spec.ingress ?? []).length);

export const m4_5: Mission = {
  id: '4.5', chapter: 4, order: 5, title: 'Default deny', tagline: 'Segment the tiers without dropping a single customer.',
  ticket: {
    from: 'Kenji (Security)', priority: 'P2', subject: 'Audit finding: every pod can reach cargo-db',
    body: [
      'Pen-test result: from any pod in the cluster — the `tools` pod in freight will do — you can open a connection to cargo-db. Flat network, no segmentation.',
      'Required state for the freight namespace: default-deny for ingress; customers may reach frontend (8080); only frontend may call cargo-api (8080); only cargo-api may reach cargo-db (6379).',
      'Two policies are prepared in ~/policies/. Write the missing ones. Traffic is live: a default-deny applied before the allow rules is an outage you caused.',
    ],
  },
  concepts: [
    { title: 'Pods are open until a policy selects them', body: 'Without NetworkPolicy every Pod accepts connections from everywhere. As soon as **any** policy with `policyTypes: [Ingress]` selects a Pod, that Pod is isolated: only what some policy explicitly allows gets in. Policies are additive — there is no "deny" rule, only the absence of an allow.', example: 'kubectl get netpol -n freight\nkubectl describe netpol default-deny -n freight' },
    { title: 'Anatomy of a rule', body: '`podSelector` picks the Pods the policy protects. Each `ingress` item combines `from` (podSelector, namespaceSelector, ipBlock) and `ports`; omit `from` to allow any source. A `podSelector` in `from` only matches Pods of the policy\'s own namespace unless paired with a `namespaceSelector`.', example: 'ingress:\n- from:\n  - podSelector: {matchLabels: {app: frontend}}\n  ports:\n  - {protocol: TCP, port: 8080}' },
    { title: 'The CNI enforces it', body: 'The API server only stores NetworkPolicies. A CNI plugin that supports them (Cilium, Calico; here Cilium, eBPF-based) drops the packets — blocked connections **time out**, they are not refused. On a CNI without policy support the objects are accepted and silently ignored.', example: 'kubectl exec tools -n freight -- curl -m 3 cargo-db:6379' },
  ],
  cluster: {
    seed: 55, nodes: orbitalNodes(), namespaces: ['freight'], images: ORBITAL_IMAGES,
    objects: [...systemWorkloads(), ...freightTier(), { ageSeconds: 3600, object: pod({ name: 'tools', ns: 'freight', image: `${REG}/debug:1.0`, labels: { run: 'tools' } }) }],
    traffic: [{ id: 'customers', service: 'freight/frontend', path: '/cargo', rps: 10, label: 'customers' }],
  },
  files: {
    'policies/default-deny.yaml': 'apiVersion: networking.k8s.io/v1\nkind: NetworkPolicy\nmetadata:\n  name: default-deny\n  namespace: freight\nspec:\n  podSelector: {}\n  policyTypes:\n  - Ingress\n',
    'policies/allow-frontend.yaml': NP('allow-frontend', { app: 'frontend' }, 8080),
  },
  objectives: [
    { id: 'open', text: 'Prove the finding: reach cargo-db from the tools pod', check: (c) => c.history.some((h) => /^(kubectl|k) exec\b.*tools.*--\s*(nc|curl|wget)\b.*cargo-db/.test(h.line) && h.code === 0) },
    { id: 'tiers', text: 'Policies allow customers → frontend → cargo-api → cargo-db, and nothing else', check: (c) => defaultDeny(c) && tierMatrix(c, 'external') },
    { id: 'deny', text: 'A default-deny ingress policy covers every pod in freight', check: (c) => defaultDeny(c) },
    { id: 'verify', text: 'The tools pod can no longer reach cargo-db (the connection times out)', check: (c) => defaultDeny(c) && tierMatrix(c, 'external') && c.history.some((h) => /^(kubectl|k) exec\b.*tools.*--\s*(nc|curl|wget)\b.*cargo-db/.test(h.line) && h.code !== 0) },
  ],
  hints: [
    { text: 'Before: `kubectl exec tools -n freight -- nc -z cargo-db 6379` succeeds. Read ~/policies/allow-frontend.yaml: it allows port 8080 to `app=frontend` from anyone. You need two more files shaped like it, each with a `from` clause.', cost: 100 },
    { text: 'allow-cargo-api: `podSelector: {matchLabels: {app: cargo-api}}`, ingress `from: [{podSelector: {matchLabels: {app: frontend}}}]`, port 8080. allow-cargo-db: selects `app: cargo-db`, from `app: cargo-api`, port 6379.', cost: 150 },
    { text: 'Apply everything in one go so the allow rules land with the deny: `kubectl apply -f policies/`. Then `kubectl exec tools -n freight -- nc -z -w 3 cargo-db 6379` must fail while the SLO stays green.', cost: 150 },
  ],
  par: { timeSec: 480, commands: 8 }, timeLimitSec: 900, slo: { minAvailability: 0.97 },
  solution: [
    'kubectl exec tools -n freight -- nc -z cargo-db 6379',
    'cat policies/allow-frontend.yaml',
    'cp policies/allow-frontend.yaml policies/allow-cargo-api.yaml',
    { edit: 'policies/allow-cargo-api.yaml', replace: [/[\s\S]*/, NP('allow-cargo-api', { app: 'cargo-api' }, 8080, 'from:\n    - podSelector:\n        matchLabels:\n          app: frontend\n    ports:\n    - protocol: TCP\n      port: 8080')] },
    'cp policies/allow-frontend.yaml policies/allow-cargo-db.yaml',
    { edit: 'policies/allow-cargo-db.yaml', replace: [/[\s\S]*/, NP('allow-cargo-db', { app: 'cargo-db' }, 6379, 'from:\n    - podSelector:\n        matchLabels:\n          app: cargo-api\n    ports:\n    - protocol: TCP\n      port: 6379')] },
    'kubectl apply -f policies/',
    'kubectl get netpol -n freight',
    'kubectl exec tools -n freight -- nc -z -w 3 cargo-db 6379',
  ],
  debrief: { proTips: ['Default-deny **egress** is the next step — and the first thing it breaks is DNS: allow UDP/TCP 53 to kube-dns in kube-system before anything else.', 'Cilium (Hubble) and Calico can show dropped flows live; without that, a timeout is your only signal.', 'AdminNetworkPolicy lets cluster admins set rules that namespace owners cannot override.'] },
};

const GATEWAY_YAML = `apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: edge
  namespace: freight
spec:
  gatewayClassName: eg
  listeners:
  - name: http
    port: 80
    protocol: HTTP
`;
const ROUTES_YAML = `apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: freight
  namespace: freight
spec:
  parentRefs:
  - name: edge
  hostnames:
  - ${HOST}
  rules:
  - matches:
    - path:
        type: PathPrefix
        value: /api
    backendRefs:
    - name: cargo-api
      port: 80
  - matches:
    - path:
        type: PathPrefix
        value: /
    backendRefs:
    - name: frontend
      port: 80
`;
const FROM_GATEWAY = 'from:\n    - namespaceSelector:\n        matchLabels:\n          kubernetes.io/metadata.name: envoy-gateway-system';
const GW_PEER: Peer = { namespace: 'envoy-gateway-system', labels: { 'app.kubernetes.io/name': 'envoy' } };
const httpsListener = (c: ObjectiveContext): boolean => {
  const gw = c.view.get('Gateway', 'freight', 'edge');
  const ls = ((gw?.spec as { listeners?: { protocol: string; port: number; tls?: { certificateRefs?: { name: string }[] } }[] } | undefined)?.listeners) ?? [];
  const programmed = ((gw?.status as { conditions?: Condition[] } | undefined)?.conditions ?? []).some((x) => x.type === 'Programmed' && x.status === 'True');
  return programmed && ls.some((l) => l.protocol === 'HTTPS' && l.port === 443 && l.tls?.certificateRefs?.some((r) => r.name === 'freight-tls')) && c.view.get<Secret>('Secret', 'freight', 'freight-tls')?.type === 'kubernetes.io/tls';
};
const capRoute = (c: ObjectiveContext): boolean => {
  const r = c.view.get('HTTPRoute', 'freight', 'freight') ?? c.view.list('HTTPRoute', 'freight')[0];
  const parents = ((r?.status as { parents?: { conditions?: Condition[] }[] } | undefined)?.parents) ?? [];
  const rules = ((r?.spec as { rules?: { matches?: { path?: { value?: string } }[]; backendRefs?: { name: string }[] }[] } | undefined)?.rules) ?? [];
  const to = (path: string, svc: string): boolean => rules.some((x) => (x.matches ?? [{}]).some((m) => (m.path?.value ?? '/') === path) && x.backendRefs?.some((b) => b.name === svc));
  return parents.some((p) => ['Accepted', 'ResolvedRefs'].every((t) => p.conditions?.some((x) => x.type === t && x.status === 'True'))) && to('/api', 'cargo-api') && to('/', 'frontend');
};
/** Capstone matrix: only the gateway's proxies reach frontend and cargo-api; cargo-db only from cargo-api. */
function capMatrix(c: ObjectiveContext): boolean {
  const one = (sel: string): Pod | undefined => c.view.readyPods('freight', sel)[0];
  const fe = one('app=frontend'), api = one('app=cargo-api'), db = one('app=cargo-db'), tools = c.view.pod('freight', 'tools');
  if (!fe || !api || !db || !tools) return false;
  const e = c.engine;
  return defaultDeny(c) && ingressAllowed(e, GW_PEER, fe, 8080) && ingressAllowed(e, GW_PEER, api, 8080) && ingressAllowed(e, podPeer(api), db, 6379)
    && !ingressAllowed(e, EXTERNAL, fe, 8080) && !ingressAllowed(e, podPeer(tools), api, 8080) && !ingressAllowed(e, podPeer(tools), db, 6379) && !ingressAllowed(e, podPeer(fe), db, 6379) && !ingressAllowed(e, GW_PEER, db, 6379);
}

export const m4_6: Mission = {
  id: '4.6', chapter: 4, order: 6, title: 'Capstone: The front door', tagline: 'TLS at the edge, least privilege behind it.',
  ticket: {
    from: 'Chief Helmsman Okafor', priority: 'P1', subject: `Go-live: https://${HOST} through our own Gateway, tiers locked down`,
    body: [
      `Freight gets its own Gateway today. In namespace freight: Gateway \`edge\` (class \`eg\`) terminating HTTPS on 443 with Secret \`freight-tls\` (certificate in ~/certs/), and one HTTPRoute for ${HOST}: \`/api\` → cargo-api, \`/\` → frontend. Starting manifests are in ~/manifests/.`,
      'Security signs off only with segmentation: default-deny ingress in freight; frontend and cargo-api accept traffic only from the Gateway\'s proxies (they run in namespace `envoy-gateway-system`); cargo-db only from cargo-api. Policies go in ~/policies/ — one is there as a model.',
      'Customers start arriving on the Gateway address as soon as it exists. Order your changes so they never hit a locked door.',
    ],
  },
  concepts: [
    { title: 'HTTPS listeners', body: 'A Gateway listener with `protocol: HTTPS` needs `tls.certificateRefs` pointing at a `kubernetes.io/tls` Secret (same namespace unless a ReferenceGrant says otherwise). Until the Secret resolves, the listener reports `ResolvedRefs: False / InvalidCertificateRef` and is not served.', example: 'listeners:\n- name: https\n  port: 443\n  protocol: HTTPS\n  tls:\n    certificateRefs:\n    - name: freight-tls' },
    { title: 'Who is the client now?', body: 'Behind a Gateway or Ingress, Pods are not called by "the internet" but by the **proxy Pods**. NetworkPolicies must allow *them*: select their namespace with `namespaceSelector` on the automatic label `kubernetes.io/metadata.name`.', example: 'from:\n- namespaceSelector:\n    matchLabels:\n      kubernetes.io/metadata.name: envoy-gateway-system' },
    { title: 'Order of operations', body: 'Additive policies make a safe sequence possible: build the route and test it, apply allow rules together with the default-deny, verify from an outsider Pod. Status conditions (`Programmed`, `Accepted`, `ResolvedRefs`) tell you each layer is ready before you lean on it.', example: 'kubectl get gateway,httproute -n freight\nkubectl apply -f policies/' },
  ],
  cluster: {
    seed: 56, nodes: orbitalNodes(), namespaces: ['freight'], images: ORBITAL_IMAGES,
    objects: [...systemWorkloads(), ...envoyGateway(), ...freightTier(`${REG}/frontend:1.4.1`), { ageSeconds: 3600, object: pod({ name: 'tools', ns: 'freight', image: `${REG}/debug:1.0`, labels: { run: 'tools' } }) }],
    traffic: [{ id: 'customers', service: envoySvc('freight', 'edge'), http: { host: HOST, path: '/', tls: true }, rps: 6, label: 'customers (https)' }, { id: 'api', service: envoySvc('freight', 'edge'), http: { host: HOST, path: '/api/cargo', tls: true }, rps: 3, label: 'cargo API' }],
  },
  files: {
    'certs/freight.crt': CERT.crt, 'certs/freight.key': CERT.key,
    'manifests/gateway.yaml': GATEWAY_YAML, 'manifests/routes.yaml': ROUTES_YAML,
    'policies/default-deny.yaml': 'apiVersion: networking.k8s.io/v1\nkind: NetworkPolicy\nmetadata:\n  name: default-deny\n  namespace: freight\nspec:\n  podSelector: {}\n  policyTypes:\n  - Ingress\n',
    'policies/allow-frontend.yaml': NP('allow-frontend', { app: 'frontend' }, 8080, `${FROM_GATEWAY}\n    ports:\n    - protocol: TCP\n      port: 8080`),
  },
  objectives: [
    { id: 'gateway', text: 'Gateway edge serves HTTPS on 443 with freight-tls (Programmed)', check: httpsListener },
    { id: 'route', text: `HTTPRoute for ${HOST} is Accepted: /api → cargo-api, / → frontend`, check: capRoute },
    { id: 'https', text: 'curl the site over HTTPS through the Gateway address (certificate verified)', check: (c) => c.history.some((h) => /^curl\b/.test(h.line) && !/(^|\s)(-k|--insecure)(\s|$)/.test(h.line) && h.expanded.includes(`https://${HOST}`) && h.code === 0 && /freight-frontend|CRG-1042/.test(h.stdout)) },
    { id: 'segment', text: 'Default-deny in freight; only the Gateway reaches frontend and cargo-api; only cargo-api reaches cargo-db', check: capMatrix },
    { id: 'outsider', text: 'From the tools pod, cargo-api and cargo-db are unreachable', check: (c) => capMatrix(c) && c.history.some((h) => /^(kubectl|k) exec\b.*tools.*--\s*(nc|curl|wget)\b.*cargo-(db|api)/.test(h.line) && h.code !== 0) },
  ],
  hints: [
    { text: 'Secret first: `kubectl create secret tls freight-tls --cert=certs/freight.crt --key=certs/freight.key -n freight`. In manifests/gateway.yaml add a second listener: `name: https`, `port: 443`, `protocol: HTTPS`, `tls: {certificateRefs: [{name: freight-tls}]}`. Apply both manifests; `kubectl get gateway,httproute -n freight`.', cost: 120 },
    { text: `Test: \`curl --resolve ${HOST}:443:ADDRESS https://${HOST}/\`. Then policies: copy allow-frontend.yaml to allow-cargo-api.yaml (selector \`app: cargo-api\`, same \`from\`), and write allow-cargo-db.yaml (selects \`app: cargo-db\`, from \`podSelector: {matchLabels: {app: cargo-api}}\`, port 6379).`, cost: 150 },
    { text: '`kubectl apply -f policies/` applies deny and allows together. Verify as an outsider: `kubectl exec tools -n freight -- nc -z -w 3 cargo-db 6379` must fail, and the SLO must stay green.', cost: 150 },
  ],
  par: { timeSec: 720, commands: 14 }, timeLimitSec: 1200, slo: { minAvailability: 0.7 },
  solution: [
    'kubectl create secret tls freight-tls --cert=certs/freight.crt --key=certs/freight.key -n freight',
    { edit: 'manifests/gateway.yaml', replace: ['    protocol: HTTP\n', '    protocol: HTTP\n  - name: https\n    port: 443\n    protocol: HTTPS\n    tls:\n      certificateRefs:\n      - name: freight-tls\n'] },
    'kubectl apply -f manifests/',
    'sleep 12',
    'kubectl get gateway,httproute -n freight',
    `curl -s --resolve ${HOST}:443:$(kubectl get gateway edge -n freight -o jsonpath='{.status.addresses[0].value}') https://${HOST}/api/cargo`,
    'cp policies/allow-frontend.yaml policies/allow-cargo-api.yaml',
    { edit: 'policies/allow-cargo-api.yaml', replace: [/[\s\S]*/, NP('allow-cargo-api', { app: 'cargo-api' }, 8080, `${FROM_GATEWAY}\n    ports:\n    - protocol: TCP\n      port: 8080`)] },
    'cp policies/allow-frontend.yaml policies/allow-cargo-db.yaml',
    { edit: 'policies/allow-cargo-db.yaml', replace: [/[\s\S]*/, NP('allow-cargo-db', { app: 'cargo-db' }, 6379, 'from:\n    - podSelector:\n        matchLabels:\n          app: cargo-api\n    ports:\n    - protocol: TCP\n      port: 6379')] },
    'kubectl apply -f policies/',
    'kubectl get netpol -n freight',
    'kubectl exec tools -n freight -- nc -z -w 3 cargo-db 6379',
  ],
  debrief: { proTips: ['With a service mesh (Istio ambient, Linkerd, Cilium) the same intent becomes identity-based: mTLS between workloads and L7 authorization, not just IPs and ports.', 'Dual-stack clusters give Pods and Services both IPv4 and IPv6; `ipBlock` rules then need both families.', 'Keep policies next to the workload manifests and review them together: a renamed label silently opens or closes a path.'] },
};

export const chapter4b: Mission[] = [m4_3, m4_4, m4_5, m4_6];
void ((0 as unknown) as KubeObject); void outputHad;
