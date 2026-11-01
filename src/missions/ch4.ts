import type { Mission } from '../game/mission.ts';
import { ORBITAL_IMAGES, REG, deployment, service, pod, orbitalNodes, systemWorkloads, usedCmd, outputHad } from './lib.ts';
import type { Service } from '../engine/types.ts';

export const m4_1: Mission = {
  id: '4.1', chapter: 4, order: 1, title: 'Nobody\'s home', tagline: 'A Service with no endpoints is a very quiet Service.',
  ticket: {
    from: 'PagerDuty → cargo-api', priority: 'P1', subject: 'cargo page returns errors; cargo-api pods look healthy?!',
    body: [
      'Team-cargo renamed some labels during a "cleanup" PR this morning. Since then the frontend cannot reach cargo-api, yet all cargo-api pods are Running and Ready.',
      'Find out why the Service is not delivering traffic and fix it. Either the Service or the Deployment can be the right thing to change — pick one and keep it consistent.',
      'There is a tools pod in freight with curl and nslookup if you want to test from inside the cluster.',
    ],
  },
  concepts: [
    { title: 'A Service is a selector + a virtual IP', body: 'A **Service** gets a stable ClusterIP and DNS name; kube-proxy forwards to the Pods matched by `spec.selector`. No matching, ready Pods → no **endpoints** → connections are refused. `kubectl get endpoints NAME` (or `endpointslices`) is the fastest check.', example: 'kubectl get svc,endpoints cargo-api\nkubectl describe svc cargo-api' },
    { title: 'Labels on Pods, selector on Service', body: 'The Service selector must match the **Pod** labels (from the Deployment\'s template), not the Deployment\'s own labels. Every selector entry must match (AND), so adding a matching entry does not cancel a stale one. Compare `kubectl get pods --show-labels` with `kubectl get svc -o wide` (SELECTOR column).', example: 'kubectl get pods -l app=cargo-api --show-labels\nkubectl get svc cargo-api -o wide' },
    { title: 'Cluster DNS', body: 'Inside the cluster `cargo-api` resolves to `cargo-api.freight.svc.cluster.local` thanks to the Pod\'s resolv.conf search list. DNS answering with an IP but connections failing means the Service exists but has no endpoints.', example: 'kubectl exec tools -- nslookup cargo-api\nkubectl exec tools -- curl -s cargo-api/healthz' },
  ],
  cluster: {
    seed: 51, nodes: orbitalNodes(), namespaces: ['freight'], images: ORBITAL_IMAGES,
    objects: [
      ...systemWorkloads(),
      { ageSeconds: 3 * 86400, object: deployment({ name: 'frontend', ns: 'freight', image: `${REG}/frontend:1.4.0`, replicas: 2, port: 8080 }) },
      { ageSeconds: 3 * 86400, object: service({ name: 'frontend', ns: 'freight', selector: { app: 'frontend' }, port: 80, targetPort: 8080 }) },
      { ageSeconds: 1500, object: deployment({ name: 'cargo-api', ns: 'freight', image: `${REG}/cargo-api:2.1.0`, replicas: 2, port: 8080, labels: { 'app.kubernetes.io/name': 'cargo-api', 'app.kubernetes.io/part-of': 'freight' }, env: [{ name: 'CARGO_DB_URL', value: 'postgres://cargo-db:5432/cargo' }] }) },
      { ageSeconds: 3 * 86400, object: service({ name: 'cargo-api', ns: 'freight', selector: { app: 'cargo-api' }, port: 80, targetPort: 8080 }) },
      { ageSeconds: 3600, object: pod({ name: 'tools', ns: 'freight', image: `${REG}/debug:1.0`, labels: { run: 'tools' } }) },
    ],
    traffic: [{ id: 'cargo', service: 'freight/cargo-api', rps: 10, label: 'cargo page' }, { id: 'customers', service: 'freight/frontend', rps: 4, label: 'customers' }],
  },
  objectives: [
    { id: 'endpoints', text: 'Check the Service endpoints (get endpoints / describe svc)', check: (c) => (usedCmd(c, /^kubectl (get|describe) (endpoints?|ep|endpointslices?|svc|services?)\b.*cargo-api/) || usedCmd(c, /^kubectl get (endpoints?|ep|endpointslices?)\b/)) && outputHad(c, /<none>|Endpoints:\s+<none>|<unset>/) },
    { id: 'compare', text: 'Compare the Service selector with the pod labels (-o wide / --show-labels)', check: (c) => (usedCmd(c, /^kubectl get (svc|services?)\b.*-o[= ]wide/) || usedCmd(c, /^kubectl describe (svc|services?)/)) && usedCmd(c, /^kubectl get (pods?|po)\b.*--show-labels/) },
    { id: 'dns', text: 'Bonus: test from inside the cluster with the tools pod (nslookup / curl)', optional: true, check: (c) => usedCmd(c, /^kubectl exec .*tools.* -- (nslookup|curl|wget).*cargo-api/) },
    { id: 'fix', text: 'cargo-api has 2 ready endpoints and traffic flows again', check: (c) => c.view.endpointsReady('freight', 'cargo-api') === 2 && c.view.deploymentReady('freight', 'cargo-api', 2) },
  ],
  hints: [
    { text: '`kubectl get endpoints cargo-api -n freight` → `<none>`. `kubectl get svc cargo-api -n freight -o wide` shows the selector; `kubectl get pods -n freight --show-labels` shows what the pods actually carry.', cost: 100 },
    { text: 'The selector says `app=cargo-api`; the pods have `app.kubernetes.io/name=cargo-api`. Every selector entry must match a Pod label; adding the new key while keeping the old one still selects no pods.', cost: 100 },
    { text: 'Easiest: `kubectl edit svc cargo-api -n freight` and under `spec.selector`, replace `app: cargo-api` with `app.kubernetes.io/name: cargo-api`. Remove the old `app` entry; do not keep both. Save, then Resume if paused. Check `kubectl get endpoints cargo-api -n freight` for two addresses.', cost: 150 },
  ],
  par: { timeSec: 300, commands: 7 }, timeLimitSec: 600, slo: { minAvailability: 0.3 },
  solution: ['kubectl get endpoints cargo-api -n freight', 'kubectl get svc cargo-api -n freight -o wide', 'kubectl get pods -n freight --show-labels', 'kubectl exec tools -n freight -- curl -s cargo-api/healthz', { edit: '__kubectl_edit__ svc cargo-api -n freight', replace: [/selector:\n    app: cargo-api/, 'selector:\n    app.kubernetes.io/name: cargo-api'] }, 'kubectl get endpoints cargo-api -n freight', 'sleep 2'],
  debrief: { proTips: ['`kubectl get endpointslices -l kubernetes.io/service-name=cargo-api` is the modern, scalable form of endpoints.', 'Named target ports (`targetPort: http`) survive container port changes.', 'A readiness probe failing also empties endpoints — "no endpoints" has two usual suspects: labels and readiness.'] },
};

export const m4_2: Mission = {
  id: '4.2', chapter: 4, order: 2, title: 'Open to the world', tagline: 'NodePort, LoadBalancer and port vs targetPort.',
  ticket: {
    from: 'Priya (QA)', priority: 'P3', subject: 'Expose the frontend for external testing',
    body: [
      'QA needs to reach the frontend from outside the cluster. First expose the frontend Deployment as a NodePort service named `frontend-nodeport` on port 80 → container 8080 and verify it with curl against a node IP.',
      'Then expose it again as a LoadBalancer named `frontend-lb` (port 80 → 8080) and verify against the external IP once the cloud assigns one.',
      'The node IPs are in `kubectl get nodes -o wide`.',
    ],
  },
  concepts: [
    { title: 'ClusterIP, NodePort, LoadBalancer', body: '**ClusterIP** (default) is reachable only inside the cluster. **NodePort** additionally opens the same port (30000–32767) on every node. **LoadBalancer** asks the cloud for an external IP that forwards to the NodePort. Each level builds on the previous one.', example: 'kubectl expose deployment frontend --type=NodePort --port=80 --target-port=8080 --name=frontend-nodeport' },
    { title: 'port vs targetPort vs nodePort', body: '`port` is the Service\'s own port (what clients use with the ClusterIP/DNS name). `targetPort` is the container port traffic is sent to. `nodePort` is the per-node port for NodePort/LoadBalancer services. `kubectl get svc` shows `80:31234/TCP` = port:nodePort.', example: 'kubectl get svc frontend-nodeport\ncurl 172.18.0.3:31234' },
    { title: '<pending> external IP', body: 'A LoadBalancer Service shows `<pending>` until the cloud controller provisions the balancer (seconds to minutes). On bare metal with no LB controller it stays pending forever — MetalLB or an Ingress controller fills that gap.', example: 'kubectl get svc frontend-lb -w' },
  ],
  cluster: {
    seed: 52, nodes: orbitalNodes(), namespaces: ['freight'], images: ORBITAL_IMAGES,
    objects: [
      ...systemWorkloads(),
      { ageSeconds: 3 * 86400, object: deployment({ name: 'frontend', ns: 'freight', image: `${REG}/frontend:1.4.0`, replicas: 2, port: 8080 }) },
      { ageSeconds: 3 * 86400, object: service({ name: 'frontend', ns: 'freight', selector: { app: 'frontend' }, port: 80, targetPort: 8080 }) },
    ],
    traffic: [{ id: 'customers', service: 'freight/frontend', rps: 4, label: 'customers' }],
  },
  objectives: [
    { id: 'nodeport', text: 'Create NodePort service frontend-nodeport (80 → 8080) selecting the frontend pods', check: (c) => { const s = c.view.service('freight', 'frontend-nodeport'); return !!s && s.spec.type === 'NodePort' && (s.spec.ports ?? []).some((p) => p.port === 80 && String(p.targetPort) === '8080' && !!p.nodePort) && c.view.endpointsReady('freight', 'frontend-nodeport') === 2; } },
    { id: 'curl-np', text: 'curl the frontend through a node IP and the NodePort', check: (c) => usedCmd(c, /^curl .*172\.18\.0\.\d+:3\d{4}/) && outputHad(c, /freight-frontend 1\.4\.0 ok/) },
    { id: 'lb', text: 'Create LoadBalancer service frontend-lb (80 → 8080) and wait for an external IP', check: (c) => { const s = c.view.service('freight', 'frontend-lb') as Service | undefined; return !!s && s.spec.type === 'LoadBalancer' && !!s.status.loadBalancer?.ingress?.[0]?.ip; } },
    { id: 'curl-lb', text: 'curl the frontend through the external IP', check: (c) => usedCmd(c, /^curl .*203\.0\.113\.\d+/) && outputHad(c, /freight-frontend 1\.4\.0 ok/) },
  ],
  hints: [
    { text: '`kubectl expose deployment frontend -n freight --type=NodePort --port=80 --target-port=8080 --name=frontend-nodeport`, then `kubectl get svc -n freight` to read the nodePort (80:3XXXX).', cost: 100 },
    { text: '`kubectl get nodes -o wide` → INTERNAL-IP. Then `curl <node-ip>:<nodePort>`.', cost: 100 },
    { text: 'Same with `--type=LoadBalancer --name=frontend-lb`; watch `kubectl get svc frontend-lb -n freight -w` until EXTERNAL-IP is assigned, then curl it on port 80.', cost: 100 },
  ],
  par: { timeSec: 300, commands: 8 },
  solution: ['kubectl expose deployment frontend -n freight --type=NodePort --port=80 --target-port=8080 --name=frontend-nodeport', 'sleep 1', 'kubectl get svc -n freight', 'kubectl get nodes -o wide', 'curl -s 172.18.0.3:$(kubectl get svc frontend-nodeport -n freight -o jsonpath=\'{.spec.ports[0].nodePort}\')', 'kubectl expose deployment frontend -n freight --type=LoadBalancer --port=80 --target-port=8080 --name=frontend-lb', 'sleep 8', 'kubectl get svc frontend-lb -n freight', 'curl -s $(kubectl get svc frontend-lb -n freight -o jsonpath=\'{.status.loadBalancer.ingress[0].ip}\')'],
  debrief: { proTips: ['Ingress / Gateway API give you host- and path-based routing and TLS on top of one LoadBalancer — next tickets.', '`externalTrafficPolicy: Local` preserves client IPs on NodePort/LB services at the cost of only routing to local pods.', 'NodePort ranges are configurable on the API server (`--service-node-port-range`).'] },
};

export const chapter4: Mission[] = [m4_1, m4_2];
