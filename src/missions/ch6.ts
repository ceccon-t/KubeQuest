/** Chapter 6 — Operating in production: scheduling, autoscaling, disruptions, quotas, upgrades. */
import type { Mission, ObjectiveContext } from '../game/mission.ts';
import { ORBITAL_IMAGES, REG, deployment, service, orbitalNodes, systemWorkloads, usedCmd, outputHad } from './lib.ts';
import type { KubeObject, Node, Pod, HorizontalPodAutoscaler, PodDisruptionBudget, LimitRange, CronJob } from '../engine/types.ts';
import type { NodeSetup } from '../engine/engine.ts';
import { isPodReady } from '../engine/controllers/kubelet.ts';

const stderrHad = (c: ObjectiveContext, re: RegExp): boolean => c.history.some((h) => re.test(h.stderr));
const zoneOf = (c: ObjectiveContext, p: Pod): string | undefined => c.view.node(p.spec.nodeName ?? '')?.metadata.labels?.['topology.kubernetes.io/zone'];
const drained = (c: ObjectiveContext, node: string): boolean => !!c.view.node(node)?.spec.unschedulable && c.view.pods().every((p) => p.spec.nodeName !== node || !!p.metadata.ownerReferences?.some((r) => r.kind === 'DaemonSet'));
const hpaActive = (h: HorizontalPodAutoscaler | undefined): boolean => !!h?.status.conditions?.some((x) => x.type === 'ScalingActive' && x.status === 'True');

// ---------------------------------------------------------------------------
// 6.1 Scheduling
// ---------------------------------------------------------------------------

const batchNode: NodeSetup = { name: 'orbital-batch-1', cpu: '16', memory: '32Gi', labels: { 'topology.kubernetes.io/zone': 'dock-c', 'node.orbital.local/pool': 'batch' }, taints: [{ key: 'workload', value: 'batch', effect: 'NoSchedule' }] };
const OPTIMIZER_YAML = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: route-optimizer
  namespace: freight
  labels:
    app: route-optimizer
spec:
  replicas: 2
  selector:
    matchLabels:
      app: route-optimizer
  template:
    metadata:
      labels:
        app: route-optimizer
    spec:
      containers:
      - name: optimizer
        image: ${REG}/route-optimizer:1.0.0
        resources:
          requests:
            cpu: "6"
            memory: 4Gi
`;
const FRONTEND_PINNED = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: frontend
  namespace: freight
  labels:
    app: frontend
spec:
  replicas: 3
  selector:
    matchLabels:
      app: frontend
  template:
    metadata:
      labels:
        app: frontend
    spec:
      nodeSelector:
        kubernetes.io/hostname: orbital-worker-a
      containers:
      - name: frontend
        image: ${REG}/frontend:1.4.1
        ports:
        - containerPort: 8080
        readinessProbe:
          httpGet:
            path: /readyz
            port: 8080
          periodSeconds: 5
`;

export const m6_1: Mission = {
  id: '6.1', chapter: 6, order: 1, title: 'A place for everything', tagline: 'Taints, tolerations, node selection and spreading across zones.',
  ticket: {
    from: 'Chief Helmsman Okafor', priority: 'P2', subject: 'Optimizer stuck Pending; and why are all frontends on one node?',
    body: [
      'Two scheduling problems. One: the new `route-optimizer` (6 CPU per replica) has been Pending since yesterday. We bought `orbital-batch-1` for exactly this kind of workload; it is tainted so nothing else lands there. The optimizer must run on the batch pool, and only there.',
      'Two: during last month\'s incident somebody pinned frontend to orbital-worker-a and never removed it. All three replicas sit on one machine. Remove the pin and make the scheduler spread them across zones — one per dock.',
      'Manifests are in ~/manifests/. I have a bad feeling about dock-a\'s power feed.',
    ],
  },
  concepts: [
    { title: 'Taints repel, tolerations permit', body: 'A **taint** on a node (`key=value:NoSchedule`) keeps away every Pod that does not **tolerate** it. A toleration only *allows* a Pod onto the node — it does not send it there. To dedicate nodes you need both: the taint to keep others out, and a `nodeSelector` or node affinity to bring yours in.', example: 'tolerations:\n- {key: workload, operator: Equal, value: batch, effect: NoSchedule}\nnodeSelector:\n  node.orbital.local/pool: batch' },
    { title: 'Reading FailedScheduling', body: 'A Pending Pod\'s events say why, node by node: `0/5 nodes are available: 1 node(s) had untolerated taint {workload: batch}, 3 Insufficient cpu…`. Every node appears with its reason; fix the one that names the node you wanted.', example: 'kubectl describe pod POD -n freight | grep -A4 Events\nkubectl describe node orbital-batch-1 | grep Taints' },
    { title: 'Topology spread constraints', body: '`topologySpreadConstraints` balance matching Pods across the values of a node label — zones, hosts. `maxSkew: 1` allows a difference of one; `whenUnsatisfiable: DoNotSchedule` makes it a hard rule, `ScheduleAnyway` a preference. During a rollout the old replicas match the selector too and distort the count; `matchLabelKeys: [pod-template-hash]` compares only Pods of the same revision.', example: 'topologySpreadConstraints:\n- maxSkew: 1\n  topologyKey: topology.kubernetes.io/zone\n  whenUnsatisfiable: DoNotSchedule\n  labelSelector: {matchLabels: {app: frontend}}\n  matchLabelKeys: [pod-template-hash]' },
  ],
  cluster: {
    seed: 71, nodes: [...orbitalNodes(), batchNode], namespaces: ['freight'], images: ORBITAL_IMAGES, evictionSeconds: 40,
    objects: [
      ...systemWorkloads(),
      { ageSeconds: 86400, object: { apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'route-optimizer', namespace: 'freight', labels: { app: 'route-optimizer' } }, spec: { replicas: 2, selector: { matchLabels: { app: 'route-optimizer' } }, template: { metadata: { labels: { app: 'route-optimizer' } }, spec: { containers: [{ name: 'optimizer', image: `${REG}/route-optimizer:1.0.0`, resources: { requests: { cpu: '6', memory: '4Gi' } } }] } } }, status: {} } },
      { ageSeconds: 20 * 86400, object: deployment({ name: 'frontend', ns: 'freight', image: `${REG}/frontend:1.4.1`, replicas: 3, port: 8080, readinessProbe: { httpGet: { path: '/readyz', port: 8080 }, periodSeconds: 5 }, nodeSelector: { 'kubernetes.io/hostname': 'orbital-worker-a' } }) },
      { ageSeconds: 20 * 86400, object: service({ name: 'frontend', ns: 'freight', selector: { app: 'frontend' }, port: 80, targetPort: 8080 }) },
    ],
    traffic: [{ id: 'customers', service: 'freight/frontend', rps: 10, label: 'customers' }],
  },
  files: { 'manifests/route-optimizer.yaml': OPTIMIZER_YAML, 'manifests/frontend.yaml': FRONTEND_PINNED },
  objectives: [
    { id: 'why', text: 'Read why the optimizer pods are Pending', check: (c) => outputHad(c, /untolerated taint \{workload: batch\}/) },
    { id: 'batch', text: 'route-optimizer runs 2/2 on the batch pool, selected explicitly', check: (c) => { const spec = c.view.deployment('freight', 'route-optimizer')?.spec.template.spec; const pinned = spec?.nodeSelector?.['node.orbital.local/pool'] === 'batch' || JSON.stringify(spec?.affinity ?? {}).includes('batch'); const pods = c.view.readyPods('freight', 'app=route-optimizer'); return pinned && pods.length === 2 && pods.every((p) => p.spec.nodeName === 'orbital-batch-1'); } },
    { id: 'spread', text: 'frontend is no longer pinned and runs one replica per zone', check: (c) => { const spec = c.view.deployment('freight', 'frontend')?.spec.template.spec; const pods = c.view.readyPods('freight', 'app=frontend'); return !spec?.nodeSelector?.['kubernetes.io/hostname'] && !!spec?.topologySpreadConstraints?.length && c.view.deploymentReady('freight', 'frontend', 3) && new Set(pods.map((p) => zoneOf(c, p))).size === 3; } },
    { id: 'survive', text: 'dock-a lost power: at least two frontends keep serving', revealAfter: 'spread', check: (c) => c.flags.has('dock-a-down') && c.view.node('orbital-worker-a')?.status.conditions?.find((x) => x.type === 'Ready')?.status !== 'True' && c.view.readyPods('freight', 'app=frontend').filter((p) => p.spec.nodeName !== 'orbital-worker-a').length >= 2 },
  ],
  chaos: [
    { id: 'a-down', at: { afterObjective: 'spread', delaySeconds: 8 }, action: { type: 'nodeDown', node: 'orbital-worker-a' }, announce: { from: 'node-monitor', text: 'Power event in dock-a: orbital-worker-a stopped reporting.' } },
    { id: 'a-flag', at: { afterObjective: 'spread', delaySeconds: 9 }, action: { type: 'flag', flag: 'dock-a-down' } },
  ],
  hints: [
    { text: '`kubectl get pods -n freight -o wide`, then `kubectl describe pod` on a Pending optimizer: every node is listed with a reason. `kubectl describe node orbital-batch-1 | grep -A3 Taints` and `kubectl get nodes --show-labels` show what to tolerate and what to select.', cost: 100 },
    { text: 'manifests/route-optimizer.yaml, Pod spec level: `tolerations: [{key: workload, operator: Equal, value: batch, effect: NoSchedule}]` and `nodeSelector: {node.orbital.local/pool: batch}`. Apply.', cost: 150 },
    { text: 'manifests/frontend.yaml: delete the `nodeSelector` block and add `topologySpreadConstraints` with `maxSkew: 1`, `topologyKey: topology.kubernetes.io/zone`, `whenUnsatisfiable: DoNotSchedule`, `labelSelector: {matchLabels: {app: frontend}}`, `matchLabelKeys: [pod-template-hash]`. Apply and check `kubectl get pods -n freight -o wide`. Without matchLabelKeys the three old replicas on worker-a count during the rollout and you end up 0/1/2 — deleting one Pod from the crowded zone also rebalances.', cost: 150 },
  ],
  par: { timeSec: 480, commands: 9 }, timeLimitSec: 900, slo: { minAvailability: 0.97 },
  solution: [
    'kubectl get pods -n freight -o wide',
    'kubectl describe pod -n freight -l app=route-optimizer',
    'kubectl describe node orbital-batch-1',
    { edit: 'manifests/route-optimizer.yaml', replace: ['    spec:\n      containers:\n', '    spec:\n      tolerations:\n      - key: workload\n        operator: Equal\n        value: batch\n        effect: NoSchedule\n      nodeSelector:\n        node.orbital.local/pool: batch\n      containers:\n'] },
    'kubectl apply -f manifests/route-optimizer.yaml',
    { edit: 'manifests/frontend.yaml', replace: ['      nodeSelector:\n        kubernetes.io/hostname: orbital-worker-a\n', '      topologySpreadConstraints:\n      - maxSkew: 1\n        topologyKey: topology.kubernetes.io/zone\n        whenUnsatisfiable: DoNotSchedule\n        labelSelector:\n          matchLabels:\n            app: frontend\n        matchLabelKeys:\n        - pod-template-hash\n'] },
    'kubectl apply -f manifests/frontend.yaml',
    'kubectl rollout status deployment/frontend -n freight',
    'kubectl rollout status deployment/route-optimizer -n freight',
    'kubectl get pods -n freight -o wide',
    'sleep 60',
    'kubectl get nodes',
    'kubectl get pods -n freight -o wide',
  ],
  debrief: { proTips: ['Pod anti-affinity (`podAntiAffinity` with `topologyKey: kubernetes.io/hostname`) is the older way to say "not two on one node"; spread constraints are easier to reason about and handle scale.', 'PriorityClasses decide who wins when the cluster is full: a higher-priority Pending Pod can **preempt** lower ones. Scheduling gates hold a Pod back until an external system says go.', 'The descheduler project evicts Pods that violate constraints *after* the fact — the scheduler itself only decides at creation.'] },
};

// ---------------------------------------------------------------------------
// 6.2 HPA
// ---------------------------------------------------------------------------

export const m6_2: Mission = {
  id: '6.2', chapter: 6, order: 2, title: 'Elastic', tagline: 'A Horizontal Pod Autoscaler, and the one field it cannot work without.',
  ticket: {
    from: 'Marketing → Platform', priority: 'P2', subject: 'Campaign goes live shortly: frontend must scale by itself',
    body: [
      'The campaign will multiply frontend traffic several times over, and nobody wants to sit here typing `kubectl scale`. Put a HorizontalPodAutoscaler on the frontend Deployment: 2 to 8 replicas, target 60% CPU.',
      'Last time someone tried, the autoscaler showed `<unknown>` and never moved. Find out why before the traffic arrives.',
      'One frontend replica copes with about 14 requests per second. The SLO board is watching.',
    ],
  },
  concepts: [
    { title: 'HorizontalPodAutoscaler', body: 'Every 15 seconds the HPA compares a metric with its target and sets `replicas` on the Deployment: `desired = ceil(current × metric / target)`. Scale-up is quick; scale-down waits five minutes of stable lower recommendations to avoid flapping.', example: 'kubectl autoscale deployment frontend --min=2 --max=8 --cpu-percent=60 -n freight\nkubectl get hpa -n freight -w' },
    { title: 'Utilization needs requests', body: 'CPU "60%" means 60% **of the container\'s CPU request**. A Pod without `resources.requests.cpu` has no denominator: the HPA reports `<unknown>` and `FailedGetResourceMetric: missing request for cpu`. Requests are what make autoscaling — and scheduling — meaningful.', example: 'kubectl set resources deployment frontend --requests=cpu=150m -n freight\nkubectl describe hpa frontend -n freight' },
    { title: 'Where the numbers come from', body: '**metrics-server** serves live CPU/memory (`kubectl top`) to the HPA. It is not a monitoring system: history, dashboards and alerts are Prometheus and Grafana; **kube-state-metrics** exports object state (replicas, conditions). Custom and external metrics reach the HPA through an adapter, or via KEDA.', example: 'kubectl top pods -n freight' },
  ],
  cluster: {
    seed: 72, nodes: orbitalNodes(), namespaces: ['freight'], images: ORBITAL_IMAGES,
    objects: [
      ...systemWorkloads(),
      { ageSeconds: 3 * 86400, object: deployment({ name: 'frontend', ns: 'freight', image: `${REG}/frontend:1.6.0`, replicas: 2, port: 8080, readinessProbe: { httpGet: { path: '/readyz', port: 8080 }, periodSeconds: 5 } }) },
      { ageSeconds: 3 * 86400, object: service({ name: 'frontend', ns: 'freight', selector: { app: 'frontend' }, port: 80, targetPort: 8080 }) },
    ],
    traffic: [{ id: 'customers', service: 'freight/frontend', rps: 10, label: 'customers' }],
  },
  objectives: [
    { id: 'hpa', text: 'HPA on frontend: 2–8 replicas, CPU target 60%', check: (c) => c.view.list<HorizontalPodAutoscaler>('HorizontalPodAutoscaler', 'freight').some((h) => h.spec.scaleTargetRef.name === 'frontend' && (h.spec.minReplicas ?? 1) === 2 && h.spec.maxReplicas === 8 && h.spec.metrics?.some((m) => m.resource?.name === 'cpu' && m.resource.target.averageUtilization === 60)) },
    { id: 'unknown', text: 'Find out why TARGETS shows <unknown>', check: (c) => outputHad(c, /missing request for cpu/) },
    { id: 'requests', text: 'frontend declares a CPU request and the HPA reads a real utilization', check: (c) => c.view.deployment('freight', 'frontend')?.spec.template.spec.containers[0]?.resources?.requests?.cpu !== undefined && c.view.list<HorizontalPodAutoscaler>('HorizontalPodAutoscaler', 'freight').some((h) => hpaActive(h) && h.status.currentMetrics?.[0]?.resource?.current.averageUtilization !== undefined) },
    { id: 'spike', text: 'The campaign is live: the autoscaler brings frontend to 5 or more ready replicas', revealAfter: 'requests', check: (c) => c.flags.has('campaign') && c.view.readyPods('freight', 'app=frontend').length >= 5 },
    { id: 'top', text: 'Bonus: look at live usage with kubectl top', optional: true, check: (c) => usedCmd(c, /^kubectl top (pods?|po)\b/) },
  ],
  chaos: [
    { id: 'campaign', at: { afterObjective: 'requests', delaySeconds: 10 }, action: { type: 'traffic', id: 'customers', rps: 60 }, announce: { from: 'Marketing', text: 'Campaign is live! Traffic on the frontend is climbing fast.' } },
    { id: 'campaign-flag', at: { afterObjective: 'requests', delaySeconds: 10 }, action: { type: 'flag', flag: 'campaign' } },
  ],
  hints: [
    { text: '`kubectl autoscale deployment frontend --min=2 --max=8 --cpu-percent=60 -n freight`. Give it 20 seconds, then `kubectl get hpa -n freight`: TARGETS says `cpu: <unknown>/60%`.', cost: 100 },
    { text: '`kubectl describe hpa frontend -n freight` — the condition and events say `missing request for cpu`. The Deployment has no resource requests, so there is nothing to take a percentage of.', cost: 120 },
    { text: '`kubectl set resources deployment frontend --requests=cpu=150m -n freight`. After the rollout the HPA shows a number; when the campaign starts, watch `kubectl get hpa,pods -n freight`.', cost: 150 },
  ],
  par: { timeSec: 420, commands: 8 }, timeLimitSec: 900, slo: { minAvailability: 0.8 },
  solution: [
    'kubectl autoscale deployment frontend --min=2 --max=8 --cpu-percent=60 -n freight',
    'sleep 20',
    'kubectl get hpa -n freight',
    'kubectl describe hpa frontend -n freight',
    'kubectl set resources deployment frontend --requests=cpu=150m -n freight',
    'kubectl rollout status deployment/frontend -n freight',
    'sleep 20',
    'kubectl get hpa -n freight',
    'kubectl top pods -n freight',
    'sleep 50',
    'kubectl get hpa,pods -n freight',
  ],
  debrief: { proTips: ['`behavior.scaleDown.stabilizationWindowSeconds` and scaling policies tune how fast an HPA reacts in each direction.', 'The Vertical Pod Autoscaler recommends (or sets) requests; in-place Pod resize lets it do so without restarts. Do not run VPA and HPA on the same metric.', 'More Pods need more nodes: Cluster Autoscaler or Karpenter add nodes when Pods are Pending for lack of capacity. KEDA scales on event sources — queue length, lag — down to zero.'] },
};

// ---------------------------------------------------------------------------
// 6.3 PDB + drain
// ---------------------------------------------------------------------------

export const m6_3: Mission = {
  id: '6.3', chapter: 6, order: 3, title: 'Budget for disruption', tagline: 'PodDisruptionBudgets: when a drain should wait — and when it waits forever.',
  ticket: {
    from: 'infra (Marco)', priority: 'P2', subject: 'Firmware on orbital-worker-b tonight — drain it without an outage this time',
    body: [
      'Last month two of us drained nodes at the same moment and cargo-api lost every replica for a minute. Before tonight\'s firmware window, protect cargo-api: at least 2 of its 3 replicas must stay available during voluntary disruptions.',
      'Then drain orbital-worker-b (ignore DaemonSets). I am told a drain got stuck on this cluster last week and nobody knew why — if that happens, find the cause and resolve it sensibly; the cache (`cargo-db`, one replica) may take a short restart.',
      'Tell me when the node is empty. I will ping you when it is back so you can uncordon it.',
    ],
  },
  concepts: [
    { title: 'Voluntary vs involuntary disruption', body: 'A node crash is involuntary: nothing can stop it. A drain, a node upgrade, an autoscaler removing a node are **voluntary** — they go through the **eviction API**, which consults PodDisruptionBudgets first. A PDB cannot protect you from failures; it makes maintenance polite.', example: 'kubectl get pdb -n freight\nkubectl drain orbital-worker-b --ignore-daemonsets' },
    { title: 'PodDisruptionBudget', body: 'For the Pods matched by `selector`, a PDB sets `minAvailable` or `maxUnavailable` (number or percentage). ALLOWED DISRUPTIONS is how many may be evicted right now. `kubectl drain` evicts one Pod, is refused the next (HTTP 429), retries every 5 seconds until a replacement is Ready elsewhere.', example: 'kubectl create pdb cargo-api --selector=app=cargo-api --min-available=2 -n freight' },
    { title: 'Budgets that can never be met', body: 'A PDB with `minAvailable: 1` on a single-replica workload allows zero disruptions, forever: the drain hangs. Either the workload gets a second replica, or the budget admits the truth (`maxUnavailable: 1`). `kubectl delete pod` bypasses PDBs — they only guard evictions.', example: 'kubectl get pdb -A   # look for ALLOWED DISRUPTIONS 0' },
  ],
  cluster: {
    seed: 73, nodes: orbitalNodes(), namespaces: ['freight'], images: ORBITAL_IMAGES,
    objects: [
      ...systemWorkloads(),
      { ageSeconds: 3 * 86400, object: deployment({ name: 'cargo-api', ns: 'freight', image: `${REG}/cargo-api:2.2.0`, replicas: 3, port: 8080, readinessProbe: { httpGet: { path: '/readyz', port: 8080 }, periodSeconds: 5 } }) },
      { ageSeconds: 3 * 86400, object: service({ name: 'cargo-api', ns: 'freight', selector: { app: 'cargo-api' }, port: 80, targetPort: 8080 }) },
      { ageSeconds: 5 * 86400, object: { apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'cargo-db', namespace: 'freight', labels: { app: 'cargo-db' } }, spec: { replicas: 1, selector: { matchLabels: { app: 'cargo-db' } }, template: { metadata: { labels: { app: 'cargo-db' } }, spec: { affinity: { nodeAffinity: { preferredDuringSchedulingIgnoredDuringExecution: [{ weight: 100, preference: { matchExpressions: [{ key: 'kubernetes.io/hostname', operator: 'In', values: ['orbital-worker-b'] }] } }] } }, containers: [{ name: 'db', image: 'redis:7', ports: [{ containerPort: 6379 }] }] } } }, status: {} } },
      { ageSeconds: 5 * 86400, object: service({ name: 'cargo-db', ns: 'freight', selector: { app: 'cargo-db' }, port: 6379 }) },
      { ageSeconds: 4 * 86400, object: { apiVersion: 'policy/v1', kind: 'PodDisruptionBudget', metadata: { name: 'cargo-db', namespace: 'freight' }, spec: { minAvailable: 1, selector: { matchLabels: { app: 'cargo-db' } } }, status: { currentHealthy: 0, desiredHealthy: 0, disruptionsAllowed: 0, expectedPods: 0 } } },
    ],
    traffic: [{ id: 'cargo', service: 'freight/cargo-api', path: '/', rps: 9, label: 'cargo API' }],
  },
  objectives: [
    { id: 'pdb', text: 'A PodDisruptionBudget keeps at least 2 cargo-api replicas available', check: (c) => c.view.list<PodDisruptionBudget>('PodDisruptionBudget', 'freight').some((p) => p.spec.selector?.matchLabels?.app === 'cargo-api' && (p.spec.minAvailable === 2 || p.spec.maxUnavailable === 1 || p.spec.minAvailable === '67%') && p.status.expectedPods >= 3) },
    { id: 'stuck', text: 'Start the drain and read why it is not finishing', check: (c) => c.history.some((h) => /^(kubectl|k) drain\b/.test(h.line) && /error when evicting pods\/"cargo-db-[^"]+" -n "freight" \(will retry after 5s\): Cannot evict pod as it would violate the pod's disruption budget\./.test(h.stderr)) },
    { id: 'budget', text: 'Fix the budget that can never be satisfied', check: (c) => { const p = c.view.get<PodDisruptionBudget>('PodDisruptionBudget', 'freight', 'cargo-db'); return c.history.some((h) => /Cannot evict pod/.test(h.stderr)) && (!p || p.spec.maxUnavailable !== undefined || p.spec.minAvailable === 0 || (c.view.deployment('freight', 'cargo-db')?.spec.replicas ?? 1) > 1); } },
    { id: 'drained', text: 'orbital-worker-b is drained', check: (c) => drained(c, 'orbital-worker-b') && c.history.some((h) => /^(kubectl|k) drain\b/.test(h.line) && /node\/orbital-worker-b drained/.test(h.stdout)) },
    { id: 'back', text: 'Firmware done: uncordon the node; everything Ready', revealAfter: 'drained', check: (c) => c.flags.has('firmware-done') && !c.view.node('orbital-worker-b')?.spec.unschedulable && c.view.deploymentReady('freight', 'cargo-api', 3) && c.view.deploymentReady('freight', 'cargo-db') },
  ],
  chaos: [
    { id: 'firmware', at: { afterObjective: 'drained', delaySeconds: 15 }, action: { type: 'flag', flag: 'firmware-done' }, announce: { from: 'infra (Marco)', text: 'orbital-worker-b flashed and rebooted. You can uncordon it.' } },
  ],
  hints: [
    { text: '`kubectl create pdb cargo-api --selector=app=cargo-api --min-available=2 -n freight`, check `kubectl get pdb -n freight` (ALLOWED DISRUPTIONS 1). Then `kubectl drain orbital-worker-b --ignore-daemonsets`.', cost: 100 },
    { text: 'The drain repeats `error when evicting pods/"cargo-db-…"`. Stop it (Ctrl+C) and look: `kubectl get pdb -n freight` — cargo-db has ALLOWED DISRUPTIONS 0, with one replica and minAvailable 1.', cost: 120 },
    { text: 'Make the budget honest: `kubectl patch pdb cargo-db -n freight --type merge -p \'{"spec":{"minAvailable":null,"maxUnavailable":1}}\'` (or delete it). Run the drain again; after infra reports back, `kubectl uncordon orbital-worker-b`.', cost: 150 },
  ],
  par: { timeSec: 480, commands: 9 }, timeLimitSec: 900, slo: { minAvailability: 0.98 },
  solution: [
    'kubectl get pods -n freight -o wide',
    'kubectl create pdb cargo-api --selector=app=cargo-api --min-available=2 -n freight',
    'sleep 1',
    'kubectl get pdb -n freight',
    'kubectl drain orbital-worker-b --ignore-daemonsets --timeout=12s',
    'kubectl get pdb -n freight',
    'kubectl patch pdb cargo-db -n freight --type merge -p \'{"spec":{"minAvailable":null,"maxUnavailable":1}}\'',
    'kubectl drain orbital-worker-b --ignore-daemonsets',
    'kubectl get pods -n freight -o wide',
    'sleep 18',
    'kubectl uncordon orbital-worker-b',
  ],
  debrief: { proTips: ['Cluster upgrades and node autoscalers drain nodes too — a missing PDB is an outage waiting for the next upgrade, an impossible PDB is an upgrade that never finishes.', '`unhealthyPodEvictionPolicy: AlwaysAllow` lets drains remove Pods that are already not Ready, so a crash-looping app cannot block maintenance.', 'Pair budgets with spreading: a PDB of minAvailable 2 does little if all three replicas share one node that dies.'] },
};

// ---------------------------------------------------------------------------
// 6.4 Quotas & LimitRanges
// ---------------------------------------------------------------------------

const REPORT_YAML = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: report-worker
  namespace: billing
  labels:
    app: report-worker
spec:
  replicas: 2
  selector:
    matchLabels:
      app: report-worker
  template:
    metadata:
      labels:
        app: report-worker
    spec:
      containers:
      - name: worker
        image: ${REG}/notifier:1.2.0
`;
const INVOICER_YAML = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: invoicer
  namespace: billing
  labels:
    app: invoicer
spec:
  replicas: 4
  selector:
    matchLabels:
      app: invoicer
  template:
    metadata:
      labels:
        app: invoicer
    spec:
      containers:
      - name: invoicer
        image: ${REG}/invoicer:4.2.0
        ports:
        - containerPort: 8080
        resources:
          requests:
            cpu: "1"
            memory: 1Gi
          limits:
            cpu: "1"
            memory: 1Gi
`;

export const m6_4: Mission = {
  id: '6.4', chapter: 6, order: 4, title: 'Fair shares', tagline: 'ResourceQuota, LimitRange, and Pods that are never even created.',
  ticket: {
    from: 'Billing team (Sofia)', priority: 'P3', subject: 'invoicer stuck at 2/4 and report-worker at 0/2 — no Pending pods, no errors?!',
    body: [
      'Month-end. We scaled invoicer to 4 and it sits at 2/4. We deployed report-worker and it has 0 pods. `kubectl get pods -n billing` shows nothing Pending, nothing crashing. Where are our pods?',
      'I know the billing namespace has a quota (2.5 CPU / 4Gi of requests). The invoicer really uses about 60m CPU and 120Mi. The report-worker manifest has no resource settings at all — half our manifests don\'t.',
      'Make both Deployments fully run inside the quota, and make sure manifests without resource settings stop being a problem in this namespace. Manifests: ~/manifests/.',
    ],
  },
  concepts: [
    { title: 'ResourceQuota', body: 'A **ResourceQuota** caps a namespace: total `requests.cpu`, `limits.memory`, number of Pods, Services, claims… A Pod that would exceed it is **rejected at admission** — it never exists, so nothing is Pending. The refusal lands as a `FailedCreate` event on the ReplicaSet.', example: 'kubectl describe quota -n billing\nkubectl describe rs -n billing | grep -A3 Events' },
    { title: 'Quota requires numbers', body: 'If a quota constrains `requests.cpu` or `limits.memory`, every container must declare that field, or the Pod is refused: `failed quota: … must specify limits.cpu for: worker`. One forgotten block and a Deployment produces zero Pods.', example: 'kubectl get events -n billing --sort-by=.lastTimestamp' },
    { title: 'LimitRange', body: 'A **LimitRange** gives a namespace per-container defaults (`defaultRequest`, `default` for limits) and bounds (`min`, `max`). Defaults are filled in at admission, before the quota check — so manifests without resource settings become admissible, and nobody can ask for a 64-CPU container by accident.', example: 'kubectl describe limitrange -n billing\nkubectl describe ns billing' },
  ],
  cluster: {
    seed: 74, nodes: orbitalNodes(), namespaces: ['freight', 'billing'], images: ORBITAL_IMAGES,
    objects: [
      ...systemWorkloads(),
      { ageSeconds: 40 * 86400, object: { apiVersion: 'v1', kind: 'ResourceQuota', metadata: { name: 'team-quota', namespace: 'billing' }, spec: { hard: { 'requests.cpu': '2500m', 'requests.memory': '4Gi', 'limits.cpu': '4', 'limits.memory': '8Gi', pods: '12' } } } },
      { ageSeconds: 9 * 86400, object: deployment({ name: 'invoicer', ns: 'billing', image: `${REG}/invoicer:4.2.0`, replicas: 4, port: 8080, resources: { requests: { cpu: '1', memory: '1Gi' }, limits: { cpu: '1', memory: '1Gi' } } }) },
      { ageSeconds: 9 * 86400, object: service({ name: 'invoicer', ns: 'billing', selector: { app: 'invoicer' }, port: 80, targetPort: 8080 }) },
      { ageSeconds: 600, object: { apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'report-worker', namespace: 'billing', labels: { app: 'report-worker' } }, spec: { replicas: 2, selector: { matchLabels: { app: 'report-worker' } }, template: { metadata: { labels: { app: 'report-worker' } }, spec: { containers: [{ name: 'worker', image: `${REG}/notifier:1.2.0` }] } } }, status: {} } },
    ],
  },
  files: { 'manifests/invoicer.yaml': INVOICER_YAML, 'manifests/report-worker.yaml': REPORT_YAML },
  objectives: [
    { id: 'find', text: 'Find where the missing invoicer pods were refused', check: (c) => outputHad(c, /exceeded quota: team-quota/) },
    { id: 'fit', text: 'invoicer runs 4/4 within the quota', check: (c) => c.view.deploymentReady('billing', 'invoicer', 4) },
    { id: 'must', text: 'Find why report-worker has no pods at all', check: (c) => outputHad(c, /failed quota: team-quota: must specify/) },
    { id: 'defaults', text: 'A LimitRange gives billing default requests and limits; report-worker runs 2/2 with its manifest unchanged', check: (c) => { const lr = c.view.list<LimitRange>('LimitRange', 'billing').some((l) => l.spec.limits.some((i) => i.type === 'Container' && i.default?.cpu && i.default.memory && i.defaultRequest?.cpu && i.defaultRequest.memory)); const tpl = c.view.deployment('billing', 'report-worker')?.spec.template.spec.containers[0]; return lr && !tpl?.resources?.requests && !tpl?.resources?.limits && c.view.deploymentReady('billing', 'report-worker', 2); } },
    { id: 'usage', text: 'Bonus: check how much of the quota is used', optional: true, check: (c) => usedCmd(c, /^kubectl describe (quota|resourcequotas?|ns|namespaces?)\b/) && outputHad(c, /requests\.cpu\s+\S+\s+2500m/) },
  ],
  hints: [
    { text: 'Pods that were never created leave their trace on the ReplicaSet: `kubectl describe rs -n billing` or `kubectl get events -n billing`. `kubectl describe quota -n billing` shows Used against Hard.', cost: 100 },
    { text: 'invoicer asks for a whole CPU per replica; the quota is 2.5. Right-size it in manifests/invoicer.yaml (for example requests 200m/256Mi, limits 500m/512Mi) and apply.', cost: 120 },
    { text: 'For report-worker, do not edit the Deployment: create a LimitRange in billing with `limits: [{type: Container, defaultRequest: {cpu: 100m, memory: 128Mi}, default: {cpu: 250m, memory: 256Mi}}]`. The ReplicaSet controller retries failed creates with a growing back-off (up to ~16 minutes), so do not wait for it: `kubectl rollout restart deployment/report-worker -n billing`.', cost: 150 },
  ],
  par: { timeSec: 480, commands: 10 }, timeLimitSec: 900,
  solution: [
    'kubectl get deploy,pods -n billing',
    'kubectl describe rs -n billing',
    'kubectl describe quota -n billing',
    { edit: 'manifests/invoicer.yaml', replace: ['          requests:\n            cpu: "1"\n            memory: 1Gi\n          limits:\n            cpu: "1"\n            memory: 1Gi\n', '          requests:\n            cpu: 200m\n            memory: 256Mi\n          limits:\n            cpu: 500m\n            memory: 512Mi\n'] },
    'kubectl apply -f manifests/invoicer.yaml',
    'kubectl rollout status deployment/invoicer -n billing',
    { edit: 'manifests/limitrange.yaml', replace: [/^[\s\S]*$/, 'apiVersion: v1\nkind: LimitRange\nmetadata:\n  name: container-defaults\n  namespace: billing\nspec:\n  limits:\n  - type: Container\n    defaultRequest:\n      cpu: 100m\n      memory: 128Mi\n    default:\n      cpu: 250m\n      memory: 256Mi\n'] },
    'kubectl apply -f manifests/limitrange.yaml',
    'kubectl rollout restart deployment/report-worker -n billing',
    'kubectl rollout status deployment/report-worker -n billing',
    'kubectl describe ns billing',
  ],
  debrief: { proTips: ['A rolling update needs head-room: with a quota that is 100% used, the surge Pod is refused and the old Pods cannot go first — the rollout stalls. Leave slack, or use `maxSurge: 0`.', 'Right-sizing is FinOps in practice: requests are what you pay for. OpenCost/Kubecost attribute spend per namespace from requests and usage.', 'Quotas can be scoped (`scopeSelector`) — a separate budget for a PriorityClass, or for BestEffort Pods.', 'A LimitRange `max` is a cheap guardrail against a typo like `memory: 64Gi`; `maxLimitRequestRatio` limits overcommit.'] },
};

// ---------------------------------------------------------------------------
// 6.5 Upgrades
// ---------------------------------------------------------------------------

const LEGACY_PDB = `apiVersion: policy/v1beta1
kind: PodDisruptionBudget
metadata:
  name: frontend
  namespace: freight
spec:
  minAvailable: 2
  selector:
    matchLabels:
      app: frontend
`;
const LEGACY_CRON = `apiVersion: batch/v1beta1
kind: CronJob
metadata:
  name: nightly-report
  namespace: freight
spec:
  schedule: "0 2 * * *"
  jobTemplate:
    spec:
      template:
        spec:
          restartPolicy: OnFailure
          containers:
          - name: report
            image: ${REG}/manifest-worker:0.9.0
`;
const LEGACY_HPA = `apiVersion: autoscaling/v2beta2
kind: HorizontalPodAutoscaler
metadata:
  name: frontend
  namespace: freight
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: frontend
  minReplicas: 3
  maxReplicas: 6
  metrics:
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 70
`;
const oldWorkers = (): NodeSetup[] => orbitalNodes().map((n) => (n.roles?.includes('control-plane') ? n : { ...n, version: 'v1.31.6' }));

export const m6_5: Mission = {
  id: '6.5', chapter: 6, order: 5, title: 'Upgrade window', tagline: 'Version skew, removed APIs and a rolling node upgrade.',
  ticket: {
    from: 'Platform (Liang)', priority: 'P2', subject: 'Control plane is on 1.32 — finish the upgrade: old manifests and the first worker',
    body: [
      'The control plane went to v1.32 last night; the workers are still on v1.31, which is a supported skew. Two things before we continue.',
      'One: the disaster-recovery repo still has manifests in ~/manifests/legacy/ written for API versions that no longer exist. Applying them fails. Bring them to the current API versions and apply them — the frontend PodDisruptionBudget in there is wanted before any node is touched.',
      'Two: upgrade orbital-worker-a. Drain it; our automation upgrades the kubelet once the node is empty; uncordon when it reports the new version. Traffic is live.',
    ],
  },
  concepts: [
    { title: 'API versions are promises with an end date', body: 'Beta API versions are deprecated, then **removed**: `batch/v1beta1` CronJob (1.25), `policy/v1beta1` PodDisruptionBudget (1.25), `autoscaling/v2beta2` HPA (1.26). Stored objects are migrated by the server; **your manifests are not**. After an upgrade, `kubectl apply` answers `no matches for kind`.', example: 'kubectl api-resources | grep -i cronjob\nkubectl explain cronjob | head -3' },
    { title: 'Version skew', body: 'Upgrades go control plane first, then nodes. Kubelets may be up to three minor versions older than the API server, never newer; kubectl within one. Minor versions cannot be skipped. Three releases a year, each supported for about fourteen months.', example: 'kubectl get nodes   # VERSION column\nkubectl version' },
    { title: 'Rolling node upgrade', body: 'One node at a time: `cordon` + `drain` (evictions honour PodDisruptionBudgets), upgrade or replace the node, `uncordon`, check, next. Managed services automate the loop but obey the same budgets — which is why budgets come first.', example: 'kubectl drain orbital-worker-a --ignore-daemonsets\nkubectl uncordon orbital-worker-a' },
  ],
  cluster: {
    seed: 75, nodes: oldWorkers(), namespaces: ['freight'], images: ORBITAL_IMAGES,
    objects: [
      ...systemWorkloads(),
      { ageSeconds: 3 * 86400, object: deployment({ name: 'frontend', ns: 'freight', image: `${REG}/frontend:1.6.0`, replicas: 3, port: 8080, readinessProbe: { httpGet: { path: '/readyz', port: 8080 }, periodSeconds: 5 }, resources: { requests: { cpu: '150m' } } }) },
      { ageSeconds: 3 * 86400, object: service({ name: 'frontend', ns: 'freight', selector: { app: 'frontend' }, port: 80, targetPort: 8080 }) },
    ],
    traffic: [{ id: 'customers', service: 'freight/frontend', rps: 9, label: 'customers' }],
  },
  files: { 'manifests/legacy/pdb.yaml': LEGACY_PDB, 'manifests/legacy/cronjob.yaml': LEGACY_CRON, 'manifests/legacy/hpa.yaml': LEGACY_HPA },
  objectives: [
    { id: 'skew', text: 'Check the version of every node', check: (c) => usedCmd(c, /^kubectl get (nodes?|no)\b/) && outputHad(c, /v1\.31\.6/) && outputHad(c, /v1\.32\.3/) },
    { id: 'removed', text: 'Apply the legacy manifests and read the error', check: (c) => stderrHad(c, /no matches for kind "(PodDisruptionBudget|CronJob|HorizontalPodAutoscaler)" in version "(policy\/v1beta1|batch\/v1beta1|autoscaling\/v2beta2)"/) },
    { id: 'migrated', text: 'PDB, CronJob and HPA from the legacy folder exist in the cluster', check: (c) => !!c.view.get('PodDisruptionBudget', 'freight', 'frontend') && !!c.view.get<CronJob>('CronJob', 'freight', 'nightly-report') && !!c.view.get('HorizontalPodAutoscaler', 'freight', 'frontend') },
    { id: 'drain', text: 'Drain orbital-worker-a', check: (c) => !!c.view.get('PodDisruptionBudget', 'freight', 'frontend') && drained(c, 'orbital-worker-a') },
    { id: 'upgraded', text: 'The node reports v1.32: uncordon it, frontend fully ready', revealAfter: 'drain', check: (c) => { const n = c.view.node('orbital-worker-a') as Node | undefined; return c.flags.has('a-upgraded') && n?.status.nodeInfo.kubeletVersion === 'v1.32.3' && !n.spec.unschedulable && c.view.readyPods('freight', 'app=frontend').length >= 3; } },
  ],
  chaos: [
    { id: 'upgrade-a', at: { afterObjective: 'drain', delaySeconds: 12 }, action: { type: 'custom', run: (e) => { const n = e.store.get<Node>('Node', undefined, 'orbital-worker-a'); if (n) { n.status.nodeInfo.kubeletVersion = 'v1.32.3'; n.status.nodeInfo.kubeProxyVersion = 'v1.32.3'; e.store.update(n); } } }, announce: { from: 'upgrade-bot', text: 'orbital-worker-a: kubelet upgraded to v1.32.3 and restarted. Node is Ready, still cordoned.' } },
    { id: 'upgrade-flag', at: { afterObjective: 'drain', delaySeconds: 12 }, action: { type: 'flag', flag: 'a-upgraded' } },
  ],
  hints: [
    { text: '`kubectl get nodes` shows the skew. `kubectl apply -f manifests/legacy/` fails three times with `no matches for kind … in version …`. `kubectl api-resources | grep -i -E "cronjob|poddisruption|horizontal"` shows the versions the server serves today.', cost: 100 },
    { text: 'Change only the first line of each file: `policy/v1`, `batch/v1`, `autoscaling/v2`. The fields used here are the same in the stable versions. Apply the folder again.', cost: 120 },
    { text: '`kubectl drain orbital-worker-a --ignore-daemonsets` — it proceeds one frontend at a time because of the PDB. When upgrade-bot reports, `kubectl get nodes`, then `kubectl uncordon orbital-worker-a`.', cost: 150 },
  ],
  par: { timeSec: 480, commands: 10 }, timeLimitSec: 900, slo: { minAvailability: 0.98 },
  solution: [
    'kubectl get nodes',
    'kubectl apply -f manifests/legacy/',
    'kubectl api-resources',
    { edit: 'manifests/legacy/pdb.yaml', replace: ['apiVersion: policy/v1beta1', 'apiVersion: policy/v1'] },
    { edit: 'manifests/legacy/cronjob.yaml', replace: ['apiVersion: batch/v1beta1', 'apiVersion: batch/v1'] },
    { edit: 'manifests/legacy/hpa.yaml', replace: ['apiVersion: autoscaling/v2beta2', 'apiVersion: autoscaling/v2'] },
    'kubectl apply -f manifests/legacy/',
    'kubectl drain orbital-worker-a --ignore-daemonsets',
    'sleep 14',
    'kubectl get nodes',
    'kubectl uncordon orbital-worker-a',
    'sleep 6',
  ],
  debrief: { proTips: ['Read the deprecation guide before every minor upgrade; tools like `pluto` or `kubent` scan manifests and Helm releases for removed APIs.', 'Back up before upgrading: etcd snapshots for the control plane, Velero for objects and volumes. Practise the restore.', 'Managed node pools usually *replace* nodes instead of upgrading in place (surge upgrade): same cordon-drain-replace loop, with spare capacity.'] },
};

// ---------------------------------------------------------------------------
// 6.6 Capstone
// ---------------------------------------------------------------------------

const PEAK_HPA = `apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: frontend
  namespace: freight
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: frontend
  minReplicas: 3
  maxReplicas: 10
  metrics:
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 60
`;

export const m6_6: Mission = {
  id: '6.6', chapter: 6, order: 6, title: 'Capstone: Peak day', tagline: 'Custom-metric autoscaling, a disruption budget and a drain — at the same time.',
  ticket: {
    from: 'Chief Helmsman Okafor', priority: 'P1', subject: 'Peak day: scale on real demand, and be ready to lose a node',
    body: [
      'CPU has been a poor signal for the frontend. The metrics adapter now exposes `http_requests_per_second` per Pod. Change the HPA in ~/manifests/hpa.yaml to scale on that: keep an average of 8 requests per second per replica, 3 to 10 replicas. Apply it.',
      'Protect the frontend from maintenance: a PodDisruptionBudget allowing at most 1 replica to be unavailable.',
      'Then stay on shift. Demand will jump, and storage monitoring is worried about a disk in orbital-worker-c — if they ask, drain that node immediately and leave it cordoned. SLO for the day: 90%.',
    ],
  },
  concepts: [
    { title: 'Scaling on what users feel', body: 'CPU is a proxy. Requests per second, queue depth or latency follow demand directly. A `Pods` metric averages a per-Pod value across the target\'s Pods; an adapter (prometheus-adapter, or KEDA) serves it from your monitoring system through the custom metrics API.', example: 'metrics:\n- type: Pods\n  pods:\n    metric: {name: http_requests_per_second}\n    target: {type: AverageValue, averageValue: "8"}' },
    { title: 'The three pillars', body: '**Metrics** (Prometheus, alerts via Alertmanager, dashboards in Grafana) tell you *that* something is wrong; **logs** (Loki, Fluent Bit) tell you *what* happened; **traces** (OpenTelemetry, Tempo/Jaeger) tell you *where* in a request. An alert should fire on symptoms users notice — error rate, latency — not on every cause.', example: 'kubectl top pods -n freight\nkubectl get events -n freight --sort-by=.lastTimestamp' },
    { title: 'Layers of resilience', body: 'Replicas absorb a Pod loss; spreading absorbs a node loss; an HPA absorbs demand; a PDB keeps maintenance from undoing all three. Each covers a different failure — today you need them together.', example: 'kubectl get hpa,pdb,pods -n freight -o wide' },
  ],
  cluster: {
    seed: 76, nodes: orbitalNodes(), namespaces: ['freight'], images: ORBITAL_IMAGES, customMetrics: ['http_requests_per_second'],
    objects: [
      ...systemWorkloads(),
      { ageSeconds: 3 * 86400, object: { apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'frontend', namespace: 'freight', labels: { app: 'frontend' } }, spec: { replicas: 3, selector: { matchLabels: { app: 'frontend' } }, template: { metadata: { labels: { app: 'frontend' } }, spec: { topologySpreadConstraints: [{ maxSkew: 1, topologyKey: 'topology.kubernetes.io/zone', whenUnsatisfiable: 'ScheduleAnyway', labelSelector: { matchLabels: { app: 'frontend' } } }], containers: [{ name: 'frontend', image: `${REG}/frontend:1.6.0`, ports: [{ containerPort: 8080 }], readinessProbe: { httpGet: { path: '/readyz', port: 8080 }, periodSeconds: 5 }, resources: { requests: { cpu: '150m', memory: '128Mi' } } }] } } }, status: {} } },
      { ageSeconds: 3 * 86400, object: service({ name: 'frontend', ns: 'freight', selector: { app: 'frontend' }, port: 80, targetPort: 8080 }) },
    ],
    traffic: [{ id: 'customers', service: 'freight/frontend', rps: 18, label: 'customers' }],
  },
  files: { 'manifests/hpa.yaml': PEAK_HPA },
  objectives: [
    { id: 'hpa', text: 'The HPA scales frontend on http_requests_per_second (average 8 per Pod, 3–10 replicas) and reads a value', check: (c) => { const h = c.view.get<HorizontalPodAutoscaler>('HorizontalPodAutoscaler', 'freight', 'frontend'); return !!h && (h.spec.minReplicas ?? 1) === 3 && h.spec.maxReplicas === 10 && !!h.spec.metrics?.some((m) => m.type === 'Pods' && m.pods?.metric.name === 'http_requests_per_second' && String(m.pods.target.averageValue) === '8') && hpaActive(h); } },
    { id: 'pdb', text: 'A PodDisruptionBudget allows at most one frontend replica to be unavailable', check: (c) => c.view.list<PodDisruptionBudget>('PodDisruptionBudget', 'freight').some((p) => p.spec.selector?.matchLabels?.app === 'frontend' && p.spec.maxUnavailable === 1) },
    { id: 'peak', text: 'Demand jumped: the autoscaler has at least 7 frontends ready', revealAfter: 'hpa', check: (c) => c.flags.has('peak') && c.view.readyPods('freight', 'app=frontend').length >= 7 },
    { id: 'disk', text: 'Storage called: orbital-worker-c is drained and stays cordoned', revealAfter: 'peak', check: (c) => c.flags.has('disk') && drained(c, 'orbital-worker-c') && usedCmd(c, /^kubectl drain orbital-worker-c\b/) },
    { id: 'steady', text: 'After the drain, every desired frontend replica is Ready on the remaining nodes', revealAfter: 'disk', check: (c) => { const d = c.view.deployment('freight', 'frontend'); const pods = c.view.pods('freight', 'app=frontend'); return c.flags.has('disk') && drained(c, 'orbital-worker-c') && !!d && pods.length === (d.spec.replicas ?? 0) && pods.every((p) => isPodReady(p) && p.spec.nodeName !== 'orbital-worker-c'); } },
  ],
  chaos: [
    { id: 'peak', at: { afterObjective: 'hpa', delaySeconds: 15 }, action: { type: 'traffic', id: 'customers', rps: 64 }, announce: { from: 'Marketing', text: 'Peak has started — orders are pouring in.' } },
    { id: 'peak-flag', at: { afterObjective: 'hpa', delaySeconds: 15 }, action: { type: 'flag', flag: 'peak' } },
    { id: 'disk', at: { afterObjective: 'peak', delaySeconds: 10 }, action: { type: 'flag', flag: 'disk' }, announce: { from: 'storage-monitor', text: 'SMART errors climbing on orbital-worker-c. Drain it now, do not uncordon — we are replacing the disk.' } },
  ],
  hints: [
    { text: 'In manifests/hpa.yaml replace the `metrics` entry: `- type: Pods`, `pods: {metric: {name: http_requests_per_second}, target: {type: AverageValue, averageValue: "8"}}`. Apply, wait ~20s, `kubectl get hpa -n freight` should show a value like `6/8`.', cost: 120 },
    { text: '`kubectl create pdb frontend --selector=app=frontend --max-unavailable=1 -n freight`. Then watch `kubectl get hpa,pods -n freight` as the peak arrives.', cost: 100 },
    { text: 'When storage asks: `kubectl drain orbital-worker-c --ignore-daemonsets`. It goes one Pod at a time and waits for replacements because of the budget. Do not uncordon. Check `kubectl get pods -n freight -o wide`.', cost: 150 },
  ],
  par: { timeSec: 600, commands: 10 }, timeLimitSec: 1200, slo: { minAvailability: 0.9 },
  solution: [
    { edit: 'manifests/hpa.yaml', replace: ['  - type: Resource\n    resource:\n      name: cpu\n      target:\n        type: Utilization\n        averageUtilization: 60\n', '  - type: Pods\n    pods:\n      metric:\n        name: http_requests_per_second\n      target:\n        type: AverageValue\n        averageValue: "8"\n'] },
    'kubectl apply -f manifests/hpa.yaml',
    'kubectl create pdb frontend --selector=app=frontend --max-unavailable=1 -n freight',
    'sleep 20',
    'kubectl get hpa -n freight',
    'sleep 60',
    'kubectl get hpa,pods -n freight',
    'sleep 12',
    'kubectl drain orbital-worker-c --ignore-daemonsets',
    'kubectl get pods -n freight -o wide',
    'sleep 10',
  ],
  debrief: { proTips: ['Alert on the SLO, page on burn rate: "we will exhaust this month\'s error budget in two hours" is actionable; "CPU is 85%" rarely is.', 'Node autoscalers (Cluster Autoscaler, Karpenter) would have added capacity as Pods went Pending, and removed it afterwards — the HPA\'s partner at the infrastructure layer.', 'Game days — deliberately draining a node or killing Pods at peak, in staging first — are how teams find out whether these layers really work. Chapter 8.'] },
};

export const chapter6: Mission[] = [m6_1, m6_2, m6_3, m6_4, m6_5, m6_6];
void ((0 as unknown) as KubeObject);
