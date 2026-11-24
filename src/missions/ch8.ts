/** Chapter 8 — Specialization tracks: GPU workloads, multi-tenancy, chaos engineering. */
import type { Mission, ObjectiveContext } from '../game/mission.ts';
import { ORBITAL_IMAGES, REG, deployment, service, orbitalNodes, systemWorkloads, usedCmd, outputHad } from './lib.ts';
import { crd, S } from './platform.ts';
import type { ContainerBehaviour } from '../engine/images.ts';
import type { Job, KubeObject, LimitRange, Namespace, Node, Pod, PodDisruptionBudget, ResourceQuota } from '../engine/types.ts';
import type { NodeSetup } from '../engine/engine.ts';
import type { OperatorSpec } from '../engine/controllers/crd.ts';
import { authorize, userFor } from '../engine/rbac.ts';
import { ingressAllowed, podPeer } from '../engine/netpol.ts';
import { isPodReady } from '../engine/controllers/kubelet.ts';
import { setNodeReady } from '../engine/controllers/node.ts';
import { fromLabelSelector, matches } from '../engine/selector.ts';

// ---------------------------------------------------------------------------
// 8.1 GPU workloads
// ---------------------------------------------------------------------------

const GPU = 'nvidia.com/gpu';
const ML_IMAGES: Record<string, ContainerBehaviour> = {
  'registry.orbital.local/ml/eta-train:0.4.0': {
    ports: [], memoryMiB: 2400, cpuMillis: 900, startMs: 1200, sizeBytes: 3_800_000_000, runToCompletion: { durationMs: 14_000 },
    logs: { start: ['eta-train 0.4.0', 'CUDA available: True (1 device: NVIDIA A10G, 22.5 GiB)', 'loading dataset shipments-2026Q3 (1,204,118 rows)', 'epoch 1/3  loss=0.4127', 'epoch 2/3  loss=0.2981', 'epoch 3/3  loss=0.2544', 'model saved to s3://orbital-models/eta/0.4.0'] },
    description: 'ETA model training job (needs one GPU).',
  },
  'registry.orbital.local/ml/notebook:2.1': {
    ports: [8888], memoryMiB: 900, cpuMillis: 30, startMs: 1500, sizeBytes: 5_200_000_000,
    http: { '/': { status: 200, body: 'JupyterLab\n' }, '/api/status': { status: 200, body: '{"kernels":0,"last_activity":"2026-10-02T17:41:09Z"}\n' } },
    logs: { start: ['[I ServerApp] Jupyter Server 2.14.2 is running at http://0.0.0.0:8888/lab'], loop: ['[I ServerApp] 0 active kernels'], loopEveryMs: 30_000 },
    description: 'JupyterLab with GPU drivers.',
  },
  'nvcr.io/nvidia/k8s-device-plugin:v0.17.1': {
    ports: [], memoryMiB: 30, cpuMillis: 5, startMs: 600, sizeBytes: 180_000_000, hasShell: false,
    logs: { start: ['I main.go:235] Starting NVIDIA Device Plugin', 'I server.go:197] Starting GRPC server for \'nvidia.com/gpu\'', 'I server.go:146] Registered device plugin for \'nvidia.com/gpu\' with Kubelet'] },
    description: 'NVIDIA device plugin: advertises GPUs to the kubelet.',
  },
};
const gpuTaint = { key: GPU, value: 'present', effect: 'NoSchedule' as const };
const gpuNode: NodeSetup = { name: 'orbital-gpu-1', cpu: '8', memory: '32Gi', labels: { 'topology.kubernetes.io/zone': 'dock-b', 'node.orbital.local/pool': 'gpu', 'nvidia.com/gpu.present': 'true' }, taints: [gpuTaint], extendedResources: { [GPU]: '2' } };
const TRAIN_JOB = `apiVersion: batch/v1
kind: Job
metadata:
  name: eta-train
  namespace: ml
spec:
  backoffLimit: 2
  template:
    spec:
      restartPolicy: Never
      containers:
      - name: train
        image: registry.orbital.local/ml/eta-train:0.4.0
        resources:
          limits:
            nvidia.com/gpu: 1
`;
const trainJob = (c: ObjectiveContext): Job | undefined => c.view.get<Job>('Job', 'ml', 'eta-train');

export const m8_1: Mission = {
  id: '8.1', chapter: 8, order: 1, title: 'The GPU queue', tagline: 'Extended resources, tainted accelerator nodes and a training job that never starts.',
  ticket: {
    from: 'Data science (Priya)', priority: 'P2', subject: 'eta-train has been Pending for three hours — the model review is this afternoon',
    body: [
      'Our ETA model training Job (`eta-train`, namespace ml) needs one GPU and about fifteen seconds of it. It has been Pending since this morning. The manifest is ~/ml/train-job.yaml.',
      'The cluster has one GPU node, orbital-gpu-1, with two GPUs. I do not know who else uses it. If the notebooks are in the way: the notebook team says one of their two servers has been idle since Friday and may go — keep the other.',
      'Please get the Job to complete.',
    ],
  },
  concepts: [
    { title: 'GPUs are extended resources', body: 'A **device plugin** (installed by the NVIDIA GPU Operator, with drivers and node labels) advertises `nvidia.com/gpu` on the node. Pods ask for it under `resources.limits`, in whole numbers only; a GPU is given to one container exclusively and cannot be overcommitted like CPU.', example: 'resources:\n  limits:\n    nvidia.com/gpu: 1\n\nkubectl describe node orbital-gpu-1   # Capacity, Allocatable, Allocated' },
    { title: 'Accelerator nodes are tainted', body: 'GPU nodes are expensive, so clusters taint them (`nvidia.com/gpu=present:NoSchedule`) to keep ordinary Pods off. A GPU workload needs the matching **toleration**. A Job\'s Pod template is immutable: to change it, delete the Job and create it again.', example: 'tolerations:\n- key: nvidia.com/gpu\n  operator: Exists\n  effect: NoSchedule' },
    { title: 'When GPUs run out', body: 'With all GPUs allocated, the next Pod waits: `Insufficient nvidia.com/gpu`. An idle notebook holds its GPU as firmly as a busy training run. Real platforms add queueing and quotas (**Kueue**), sharing (time-slicing, MPS, MIG), and **Dynamic Resource Allocation** for finer device requests.', example: 'kubectl get pods -A -o wide --field-selector spec.nodeName=orbital-gpu-1' },
  ],
  cluster: {
    seed: 91, nodes: [...orbitalNodes(), gpuNode], namespaces: ['ml'], images: { ...ORBITAL_IMAGES, ...ML_IMAGES },
    objects: [
      ...systemWorkloads(),
      { ageSeconds: 20 * 86400, object: { apiVersion: 'apps/v1', kind: 'DaemonSet', metadata: { name: 'nvidia-device-plugin-daemonset', namespace: 'kube-system', labels: { 'app.kubernetes.io/name': 'nvidia-device-plugin' } }, spec: { selector: { matchLabels: { name: 'nvidia-device-plugin-ds' } }, template: { metadata: { labels: { name: 'nvidia-device-plugin-ds' } }, spec: { nodeSelector: { 'nvidia.com/gpu.present': 'true' }, tolerations: [{ key: GPU, operator: 'Exists', effect: 'NoSchedule' }], priorityClassName: 'system-node-critical', containers: [{ name: 'nvidia-device-plugin-ctr', image: 'nvcr.io/nvidia/k8s-device-plugin:v0.17.1' }] } } }, status: {} } },
      { ageSeconds: 6 * 86400, object: { apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'notebook', namespace: 'ml', labels: { app: 'notebook' }, annotations: { 'orbital.local/owner': 'notebooks-team' } }, spec: { replicas: 2, selector: { matchLabels: { app: 'notebook' } }, template: { metadata: { labels: { app: 'notebook' } }, spec: { tolerations: [{ key: GPU, operator: 'Exists', effect: 'NoSchedule' }], containers: [{ name: 'jupyter', image: 'registry.orbital.local/ml/notebook:2.1', ports: [{ containerPort: 8888 }], resources: { limits: { [GPU]: '1' } } }] } } }, status: {} } },
      { ageSeconds: 3 * 3600, object: { apiVersion: 'batch/v1', kind: 'Job', metadata: { name: 'eta-train', namespace: 'ml' }, spec: { backoffLimit: 2, template: { spec: { restartPolicy: 'Never', containers: [{ name: 'train', image: 'registry.orbital.local/ml/eta-train:0.4.0', resources: { limits: { [GPU]: '1' } } }] } } }, status: {} } },
    ],
  },
  files: { 'ml/train-job.yaml': TRAIN_JOB },
  objectives: [
    { id: 'why', text: 'Read why the training Pod is not scheduled', check: (c) => outputHad(c, /untolerated taint \{nvidia\.com\/gpu: present\}/) },
    { id: 'tolerate', text: 'The Job tolerates the GPU taint (its template is immutable: recreate it)', check: (c) => !!trainJob(c)?.spec.template.spec.tolerations?.some((t) => (t.key === GPU || (!t.key && t.operator === 'Exists')) && (!t.effect || t.effect === 'NoSchedule')) && trainJob(c)?.spec.template.spec.containers[0]?.resources?.limits?.[GPU] !== undefined },
    { id: 'who', text: 'Still Pending: find out what holds the GPUs of orbital-gpu-1', check: (c) => outputHad(c, /nvidia\.com\/gpu\s+2\s+2/) || c.history.some((h) => /Insufficient nvidia\.com\/gpu/.test(h.stdout) && /notebook/.test(h.stdout)) },
    { id: 'done', text: 'eta-train completed; one notebook server is still running', check: (c) => (trainJob(c)?.status.succeeded ?? 0) >= 1 && c.view.readyPods('ml', 'app=notebook').length >= 1 },
    { id: 'logs', text: 'Read the training log: confirm the model was saved', revealAfter: 'done', check: (c) => c.history.some((h) => /^(kubectl|k) logs\b/.test(h.line) && /model saved to/.test(h.stdout)) },
  ],
  hints: [
    { text: '`kubectl get pods -n ml -o wide`, then `kubectl describe pod -n ml -l job-name=eta-train`: the events list each node\'s reason. `kubectl describe node orbital-gpu-1 | grep -i -A2 taint`.', cost: 100 },
    { text: 'Add to the Pod spec in ml/train-job.yaml: `tolerations: [{key: nvidia.com/gpu, operator: Exists, effect: NoSchedule}]`. `kubectl apply` refuses (template is immutable): `kubectl delete job eta-train -n ml`, then apply.', cost: 150 },
    { text: 'Now it says `Insufficient nvidia.com/gpu`. `kubectl describe node orbital-gpu-1` — Allocated resources shows 2 of 2, held by the notebook Pods. `kubectl scale deployment notebook --replicas=1 -n ml`, then watch `kubectl get pods,jobs -n ml`; finally `kubectl logs job/eta-train -n ml`.', cost: 150 },
  ],
  par: { timeSec: 420, commands: 13 }, timeLimitSec: 900,
  solution: [
    'kubectl get pods -n ml -o wide',
    'kubectl describe pod -n ml -l job-name=eta-train',
    { edit: 'ml/train-job.yaml', replace: ['      restartPolicy: Never\n', '      restartPolicy: Never\n      tolerations:\n      - key: nvidia.com/gpu\n        operator: Exists\n        effect: NoSchedule\n'] },
    'kubectl apply -f ml/train-job.yaml',
    'kubectl delete job eta-train -n ml',
    'kubectl apply -f ml/train-job.yaml',
    'sleep 2',
    'kubectl describe pod -n ml -l job-name=eta-train',
    'kubectl describe node orbital-gpu-1',
    'kubectl scale deployment notebook --replicas=1 -n ml',
    'sleep 22',
    'kubectl get pods,jobs -n ml',
    'kubectl logs job/eta-train -n ml',
  ],
  debrief: { proTips: ['Kueue queues batch Jobs per team with quotas and fair sharing, admitting them when capacity frees up — the grown-up answer to "who gets the GPU".', 'Idle notebooks are the classic GPU leak: culling idle kernels, time-slicing or MIG partitions stretch scarce accelerators.', 'For serving models: KServe adds autoscaling (to zero) and canaries on top of Deployments; Kubeflow bundles pipelines, notebooks and training operators.'] },
};

// ---------------------------------------------------------------------------
// 8.2 Multi-tenancy
// ---------------------------------------------------------------------------

const TENANT_APP = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: telemetry
  namespace: drones
  labels:
    app: telemetry
spec:
  replicas: 2
  selector:
    matchLabels:
      app: telemetry
  template:
    metadata:
      labels:
        app: telemetry
    spec:
      containers:
      - name: telemetry
        image: nginx:1.27
        ports:
        - containerPort: 80
---
apiVersion: v1
kind: Service
metadata:
  name: telemetry
  namespace: drones
spec:
  selector:
    app: telemetry
  ports:
  - port: 80
`;
const TENANT_YAML = `apiVersion: v1
kind: Namespace
metadata:
  name: drones
  labels:
    team: drones
    pod-security.kubernetes.io/enforce: baseline
---
apiVersion: v1
kind: ResourceQuota
metadata:
  name: team-quota
  namespace: drones
spec:
  hard:
    requests.cpu: "2"
    requests.memory: 4Gi
    limits.cpu: "4"
    limits.memory: 8Gi
    pods: "10"
---
apiVersion: v1
kind: LimitRange
metadata:
  name: container-defaults
  namespace: drones
spec:
  limits:
  - type: Container
    defaultRequest:
      cpu: 100m
      memory: 128Mi
    default:
      cpu: 500m
      memory: 256Mi
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: drones-devs-edit
  namespace: drones
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: edit
subjects:
- apiGroup: rbac.authorization.k8s.io
  kind: Group
  name: drones-devs
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny-ingress
  namespace: drones
spec:
  podSelector: {}
  policyTypes:
  - Ingress
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-same-namespace
  namespace: drones
spec:
  podSelector: {}
  policyTypes:
  - Ingress
  ingress:
  - from:
    - podSelector: {}
`;
const dev = userFor('jo', ['drones-devs']);
const devCan = (c: ObjectiveContext, verb: string, group: string, resource: string, namespace?: string): boolean => authorize(c.engine, dev, { verb, group, resource, namespace });
const hard = (c: ObjectiveContext): Record<string, string> => Object.assign({}, ...c.view.list<ResourceQuota>('ResourceQuota', 'drones').map((q) => q.spec.hard ?? {})) as Record<string, string>;

export const m8_2: Mission = {
  id: '8.2', chapter: 8, order: 2, title: 'A new tenant', tagline: 'Namespace-as-a-service: quota, defaults, access and isolation for one team.',
  ticket: {
    from: 'Platform (Liang)', priority: 'P2', subject: 'Onboard team drones — the full tenant checklist',
    body: [
      'A new team starts Monday. Give them a namespace `drones` (label `team=drones`) that enforces the Baseline Pod Security Standard, with a ResourceQuota (requests: 2 CPU / 4Gi; limits: 4 CPU / 8Gi; 10 Pods) and a LimitRange with container defaults, so their manifests without resources still deploy.',
      'Access: the group `drones-devs` gets the built-in `edit` role in their namespace only. Isolation: Pods in drones accept connections from their own namespace and from nowhere else.',
      'Then prove it works as one of them: deploy ~/tenants/drones/app.yaml as user `jo` of group `drones-devs` (impersonate with `--as` and `--as-group`).',
    ],
  },
  concepts: [
    { title: 'Soft multi-tenancy', body: 'Teams share one cluster, each inside a **namespace** fenced on four sides: **RBAC** (who may act), **ResourceQuota + LimitRange** (how much), **NetworkPolicy** (who may connect), **Pod Security** (what Pods may do). Miss one side and the fence has a gap — tenants share nodes, kernel and control plane.', example: 'kubectl describe ns drones   # labels, quota and limits in one view' },
    { title: 'Reuse the built-in roles', body: 'The ClusterRoles `view`, `edit` and `admin` exist in every cluster. A **RoleBinding** to a ClusterRole grants it in one namespace only. `edit` manages workloads, Services, ConfigMaps and Secrets — but not Roles, quotas or the namespace itself. Bind groups from your identity provider, not individual users.', example: 'kubectl create rolebinding drones-devs-edit --clusterrole=edit --group=drones-devs -n drones\nkubectl auth can-i --list -n drones --as=jo --as-group=drones-devs' },
    { title: 'Isolation by default', body: 'Without NetworkPolicy every Pod can reach every other. A tenant namespace starts with a **default-deny** ingress policy (`podSelector: {}`) plus one that allows traffic from the same namespace (`from: [{podSelector: {}}]`). Stronger isolation needs separate control planes: vcluster, or a cluster per tenant.', example: 'kubectl get networkpolicies -n drones\nkubectl exec -n freight tools -- curl -m 2 telemetry.drones' },
  ],
  cluster: {
    seed: 92, nodes: orbitalNodes(), namespaces: ['freight'], images: ORBITAL_IMAGES,
    objects: [
      ...systemWorkloads(),
      { ageSeconds: 3 * 86400, object: deployment({ name: 'frontend', ns: 'freight', image: `${REG}/frontend:1.4.1`, replicas: 2, port: 8080 }) },
      { ageSeconds: 3600, object: { apiVersion: 'v1', kind: 'Pod', metadata: { name: 'tools', namespace: 'freight', labels: { run: 'tools' } }, spec: { containers: [{ name: 'tools', image: `${REG}/debug:1.0` }] }, status: {} } },
    ],
  },
  files: { 'tenants/drones/app.yaml': TENANT_APP },
  objectives: [
    { id: 'ns', text: 'Namespace drones exists: team=drones, Pod Security enforce=baseline', check: (c) => { const l = c.view.get<Namespace>('Namespace', undefined, 'drones')?.metadata.labels ?? {}; return l.team === 'drones' && l['pod-security.kubernetes.io/enforce'] === 'baseline'; } },
    { id: 'fair', text: 'ResourceQuota (2/4Gi requests, 4/8Gi limits, 10 Pods) and LimitRange defaults are in place', check: (c) => { const h = hard(c); return h['requests.cpu'] === '2' && h['requests.memory'] === '4Gi' && h['limits.cpu'] === '4' && h['limits.memory'] === '8Gi' && h.pods === '10' && c.view.list<LimitRange>('LimitRange', 'drones').some((l) => l.spec.limits.some((i) => i.type === 'Container' && !!i.default?.cpu && !!i.default.memory && !!i.defaultRequest?.cpu && !!i.defaultRequest.memory)); } },
    { id: 'rbac', text: 'Group drones-devs can edit in drones — and nothing outside, nor the quota', check: (c) => ['create', 'update', 'delete'].every((v) => devCan(c, v, 'apps', 'deployments', 'drones')) && devCan(c, 'get', '', 'pods', 'drones') && !devCan(c, 'get', '', 'pods', 'freight') && !devCan(c, 'update', '', 'resourcequotas', 'drones') && !devCan(c, 'create', 'rbac.authorization.k8s.io', 'rolebindings', 'drones') && !devCan(c, 'list', '', 'nodes') },
    { id: 'deploy', text: 'Deployed as jo (drones-devs): telemetry is 2/2 ready', check: (c) => c.history.some((h) => /^(kubectl|k) (apply|create)\b/.test(h.line) && /--as[= ]\S+/.test(h.line) && /--as-group[= ]drones-devs/.test(h.line) && h.code === 0) && c.view.deploymentReady('drones', 'telemetry', 2) },
    { id: 'isolate', text: 'telemetry accepts connections from drones Pods only', check: (c) => { const pods = c.view.readyPods('drones', 'app=telemetry'); const outsider = c.view.pod('freight', 'tools'); const [a, b] = pods; return !!a && !!b && !!outsider && !ingressAllowed(c.engine, podPeer(outsider), a, 80) && ingressAllowed(c.engine, podPeer(b), a, 80); } },
    { id: 'probe', text: 'Bonus: check the tenant\'s permissions with kubectl auth can-i', optional: true, check: (c) => usedCmd(c, /^kubectl auth can-i\b.*--as-group[= ]drones-devs/) },
  ],
  hints: [
    { text: 'Namespace and labels: `kubectl create namespace drones`, `kubectl label ns drones team=drones pod-security.kubernetes.io/enforce=baseline`. Quota: `kubectl create quota team-quota -n drones --hard=requests.cpu=2,requests.memory=4Gi,limits.cpu=4,limits.memory=8Gi,pods=10`. The LimitRange needs a manifest (type Container, `defaultRequest` and `default`).', cost: 120 },
    { text: 'Access: `kubectl create rolebinding drones-devs-edit --clusterrole=edit --group=drones-devs -n drones`. Check: `kubectl auth can-i create deployments -n drones --as=jo --as-group=drones-devs` (yes) and `-n freight` (no).', cost: 120 },
    { text: 'Isolation: two NetworkPolicies in drones — `podSelector: {}` with `policyTypes: [Ingress]` and no rules (default deny), and one with `ingress: [{from: [{podSelector: {}}]}]` (same namespace). Then `kubectl apply -f tenants/drones/app.yaml --as=jo --as-group=drones-devs`.', cost: 150 },
  ],
  par: { timeSec: 600, commands: 12 }, timeLimitSec: 1200,
  solution: [
    { edit: 'tenants/drones/tenant.yaml', replace: [/^[\s\S]*$/, TENANT_YAML] },
    'kubectl apply -f tenants/drones/tenant.yaml',
    'kubectl describe ns drones',
    'kubectl auth can-i create deployments -n drones --as=jo --as-group=drones-devs',
    'kubectl auth can-i get pods -n freight --as=jo --as-group=drones-devs',
    'kubectl apply -f tenants/drones/app.yaml --as=jo --as-group=drones-devs',
    'kubectl rollout status deployment/telemetry -n drones',
    'kubectl get pods -n drones -o wide',
    'kubectl exec -n freight tools -- curl -s -m 2 telemetry.drones',
    'kubectl get networkpolicies -n drones',
  ],
  debrief: { proTips: ['Put the tenant bundle in Git and stamp it per team (Kustomize base, a Helm chart, or an operator such as Capsule or the Hierarchical Namespace Controller) — onboarding becomes a pull request.', 'vcluster gives each tenant its own API server inside a namespace: they can install CRDs and cluster roles without touching yours.', 'Egress matters as much as ingress: default-deny egress with explicit DNS and dependencies stops a compromised Pod from calling out.'] },
};

// ---------------------------------------------------------------------------
// 8.3 Chaos engineering
// ---------------------------------------------------------------------------

const CHAOS_REPO = 'ghcr.io/chaos-mesh/chaos-mesh';
const CHAOS_IMAGES: Record<string, ContainerBehaviour> = {
  [`${CHAOS_REPO}:v2.7.2`]: {
    ports: [10080], memoryMiB: 70, cpuMillis: 20, startMs: 1200, sizeBytes: 71_000_000, hasShell: false,
    http: { '/healthz': { status: 200, body: 'ok' } },
    logs: { start: ['INFO\tsetup\tsetting up manager', 'INFO\tsetup\tStarting manager', 'INFO\tStarting Controller\t{"controller": "podchaos-records"}'] },
    description: 'Chaos Mesh controller manager.',
  },
};
interface ChaosSpec { action?: string; mode?: string; selector?: { namespaces?: string[]; labelSelectors?: Record<string, string> } }
interface ChaosStatus { conditions?: { type: string; status: string }[] }
const injected = (o: KubeObject): boolean => !!(o.status as ChaosStatus | undefined)?.conditions?.some((x) => x.type === 'AllInjected' && x.status === 'True');
/**
 * Chaos Mesh's PodChaos controller, reduced to the one-shot `pod-kill` action. Status shape (conditions,
 * experiment.containerRecords) and the `Applied` event follow chaos-mesh api/v1alpha1/common_types.go and
 * controllers/utils/recorder/common.go.
 */
const chaosMesh: OperatorSpec = {
  image: CHAOS_REPO,
  reconcile: (api) => {
    for (const exp of api.engine.store.list('PodChaos')) {
      if (exp.metadata.deletionTimestamp || (exp.status as ChaosStatus | undefined)?.conditions) continue;
      const spec = (exp.spec ?? {}) as ChaosSpec;
      const event = (type: 'Normal' | 'Warning', reason: string, message: string): void => { api.engine.store.event({ type, reason, message, involved: exp, component: 'records' }); };
      const conditions = (selected: boolean, done: boolean): { type: string; status: string }[] => [{ type: 'Selected', status: selected ? 'True' : 'False' }, { type: 'AllInjected', status: done ? 'True' : 'False' }, { type: 'AllRecovered', status: 'False' }, { type: 'Paused', status: 'False' }];
      if (spec.action !== 'pod-kill') { event('Warning', 'Failed', `kubequest: action ${spec.action ?? ''} is not simulated; only pod-kill is`); api.setStatus(exp, { conditions: conditions(false, false), experiment: { desiredPhase: 'Run' } }); continue; }
      const reqs = fromLabelSelector({ matchLabels: spec.selector?.labelSelectors ?? {} });
      const namespaces = spec.selector?.namespaces?.length ? spec.selector.namespaces : [exp.metadata.namespace ?? 'default'];
      const pods = namespaces.flatMap((n) => api.engine.store.list<Pod>('Pod', n)).filter((p) => !p.metadata.deletionTimestamp && p.status.phase === 'Running' && matches(reqs, p.metadata.labels)).sort((a, b) => a.metadata.name.localeCompare(b.metadata.name));
      if (!pods.length) { event('Warning', 'Failed', 'no pod is selected'); api.setStatus(exp, { conditions: conditions(false, false), experiment: { desiredPhase: 'Run' } }); continue; }
      const victims = spec.mode === 'all' ? pods : [pods[api.engine.rng.int(pods.length)] as Pod];
      for (const p of victims) { api.engine.store.markDeleting(p, 0); event('Normal', 'Applied', `Successfully apply chaos for ${p.metadata.namespace}/${p.metadata.name}`); }
      api.log(`INFO\trecords\tapply chaos\t{"id": "${victims.map((p) => `${p.metadata.namespace}/${p.metadata.name}`).join(',')}"}`);
      api.setStatus(exp, { conditions: conditions(true, true), experiment: { desiredPhase: 'Run', containerRecords: victims.map((p) => ({ id: `${p.metadata.namespace}/${p.metadata.name}`, phase: 'Injected', selectorKey: '.', injectedCount: 1, recoveredCount: 0 })) } });
    }
  },
};
const POD_KILL = `apiVersion: chaos-mesh.org/v1alpha1
kind: PodChaos
metadata:
  name: kill-one-cargo-api
  namespace: freight
spec:
  action: pod-kill
  mode: one
  selector:
    namespaces:
    - freight
    labelSelectors:
      app: cargo-api
`;
const PLAN = `# Game day: freight cargo-api

Steady state: the cargo API answers customers with >= 95% success.

Experiment 1 - pod kill (gameday/pod-kill.yaml)
  Hypothesis: losing one cargo-api Pod is invisible to customers.
  Run it once against the system AS IT IS. Write down what happened.
  A PodChaos runs once; to repeat it, delete the object and apply it again.

Experiment 2 - node loss (run by infra, unannounced, after experiment 1 was repeated)
  Hypothesis: losing any single worker node is invisible to customers.
`;
const cargoPods = (c: ObjectiveContext): Pod[] => c.view.pods('freight', 'app=cargo-api').filter((p) => !p.metadata.deletionTimestamp);
const healthyNode = (c: ObjectiveContext, p: Pod): boolean => c.view.node(p.spec.nodeName ?? '')?.status.conditions?.find((x) => x.type === 'Ready')?.status === 'True';

export const m8_3: Mission = {
  id: '8.3', chapter: 8, order: 3, title: 'Game day', tagline: 'Chaos engineering: break it on purpose, on your terms, before it breaks on its own.',
  ticket: {
    from: 'Chief Helmsman Okafor', priority: 'P2', subject: 'Game day for cargo-api: prove it survives a Pod and a node',
    body: [
      'Before peak season I want evidence, not confidence. Chaos Mesh is installed (namespace chaos-mesh). The plan is in ~/gameday/plan.md, the first experiment in ~/gameday/pod-kill.yaml.',
      'Run experiment 1 against cargo-api exactly as it is today and watch the customer traffic. Then fix whatever the experiment exposes — I expect at least three replicas spread over different nodes, and a PodDisruptionBudget — and run the experiment again to prove the fix.',
      'Infra will pull the power on one worker at some point after that. The steady state — 95% of customer requests succeed — is measured from the moment your fixes are in; what the first run breaks is the lesson, not a failure.',
    ],
  },
  concepts: [
    { title: 'Chaos engineering', body: 'A controlled experiment: define the **steady state** (a metric users care about), state a **hypothesis** ("losing one Pod is invisible"), inject one failure with a limited **blast radius**, observe, fix, repeat. The goal is not to break things; it is to find the weakness on a Tuesday afternoon with everyone watching.', example: 'cat gameday/plan.md' },
    { title: 'Chaos Mesh', body: 'An operator with one CRD per failure type. **PodChaos** kills Pods or containers; NetworkChaos adds latency, loss or partitions; StressChaos burns CPU and memory. The `selector` and `mode` (`one`, `all`, `fixed-percent`) define the blast radius. `pod-kill` is one-shot: delete and re-apply to repeat.', example: 'kubectl apply -f gameday/pod-kill.yaml\nkubectl describe podchaos kill-one-cargo-api -n freight' },
    { title: 'What makes a Pod loss invisible', body: 'More than one replica, **readiness probes** so traffic only reaches Pods that can answer, and replicas on different nodes or zones (`topologySpreadConstraints`) so one machine cannot take them all. A PodDisruptionBudget covers planned maintenance; nothing but spare replicas covers a crash.', example: 'kubectl get pods -n freight -l app=cargo-api -o wide' },
  ],
  cluster: {
    seed: 93, nodes: orbitalNodes(), namespaces: ['freight'], images: { ...ORBITAL_IMAGES, ...CHAOS_IMAGES }, operators: [chaosMesh], evictionSeconds: 30,
    objects: [
      ...systemWorkloads(),
      { ageSeconds: 40 * 86400, object: { apiVersion: 'v1', kind: 'Namespace', metadata: { name: 'chaos-mesh' } } },
      { ageSeconds: 40 * 86400, object: crd({ group: 'chaos-mesh.org', kind: 'PodChaos', plural: 'podchaos', version: 'v1alpha1', spec: S.obj({ action: S.str({ enum: ['pod-kill', 'pod-failure', 'container-kill'] }), mode: S.str({ enum: ['one', 'all', 'fixed', 'fixed-percent', 'random-max-percent'] }), value: S.str(), duration: S.str(), gracePeriod: S.int(), containerNames: S.arr(S.str()), selector: S.obj({ namespaces: S.arr(S.str()), labelSelectors: S.any(), pods: S.any() }) }, ['action', 'mode', 'selector']) }) },
      { ageSeconds: 40 * 86400, object: deployment({ name: 'chaos-controller-manager', ns: 'chaos-mesh', image: `${CHAOS_REPO}:v2.7.2`, replicas: 1, port: 10080, labels: { 'app.kubernetes.io/component': 'controller-manager', 'app.kubernetes.io/name': 'chaos-mesh' } }) },
      { ageSeconds: 12 * 86400, object: deployment({ name: 'cargo-api', ns: 'freight', image: `${REG}/cargo-api:2.2.0`, replicas: 1, port: 8080, readinessProbe: { httpGet: { path: '/readyz', port: 8080 }, periodSeconds: 5 } }) },
      { ageSeconds: 12 * 86400, object: service({ name: 'cargo-api', ns: 'freight', selector: { app: 'cargo-api' }, port: 80, targetPort: 8080 }) },
    ],
    traffic: [{ id: 'cargo', service: 'freight/cargo-api', path: '/', rps: 10, label: 'cargo API' }],
  },
  files: { 'gameday/plan.md': PLAN, 'gameday/pod-kill.yaml': POD_KILL },
  objectives: [
    { id: 'first', text: 'Run experiment 1 against cargo-api as it is', check: (c) => c.view.list('PodChaos').some(injected) },
    { id: 'harden', text: 'cargo-api: 3+ ready replicas on at least 3 different nodes, protected by a PodDisruptionBudget', check: (c) => { const pods = c.view.readyPods('freight', 'app=cargo-api'); return c.view.list('PodChaos').some(injected) && pods.length >= 3 && new Set(pods.map((p) => p.spec.nodeName)).size >= 3 && (c.view.deployment('freight', 'cargo-api')?.spec.replicas ?? 0) >= 3 && c.view.list<PodDisruptionBudget>('PodDisruptionBudget', 'freight').some((p) => p.spec.selector?.matchLabels?.app === 'cargo-api'); } },
    { id: 'again', text: 'Repeat experiment 1 against the hardened system', revealAfter: 'harden', check: (c) => { const at = c.engine.scratch.get('gameday:hardenedAt') as number | undefined; return at !== undefined && c.view.list('PodChaos').some((o) => injected(o) && Date.parse(o.metadata.creationTimestamp ?? '') >= at - 1000) && c.view.readyPods('freight', 'app=cargo-api').length >= 3; } },
    { id: 'node', text: 'Experiment 2: a worker lost power — at least two replicas keep serving from healthy nodes', revealAfter: 'again', check: (c) => c.flags.has('power-cut') && c.engine.store.list<Node>('Node').some((n) => n.status.conditions?.find((x) => x.type === 'Ready')?.status !== 'True') && cargoPods(c).filter((p) => isPodReady(p) && healthyNode(c, p)).length >= 2 },
  ],
  chaos: [
    { id: 'hardened', at: { afterObjective: 'harden', delaySeconds: 0 }, action: { type: 'custom', run: (e) => { e.scratch.set('gameday:hardenedAt', e.clock.nowMs); e.traffic.resetStats(); } }, announce: { from: 'Chief Helmsman Okafor', text: 'Good — that first run is exactly why we do this. The 95% steady state is measured from now.' } },
    { id: 'power-cut', at: { afterObjective: 'again', delaySeconds: 12 }, action: { type: 'custom', run: (e) => { const victim = e.store.list<Pod>('Pod', 'freight').filter((p) => p.metadata.labels?.app === 'cargo-api' && p.spec.nodeName && !p.metadata.deletionTimestamp).map((p) => p.spec.nodeName as string).sort()[0]; if (victim) setNodeReady(e, victim, false); } }, announce: { from: 'infra (Marco)', text: 'Experiment 2 is running: we cut the power to one of the workers hosting cargo-api. Which one? Find out.' } },
    { id: 'power-flag', at: { afterObjective: 'again', delaySeconds: 13 }, action: { type: 'flag', flag: 'power-cut' } },
  ],
  hints: [
    { text: '`cat gameday/plan.md`, `kubectl get pods -n freight -o wide` (one replica), then `kubectl apply -f gameday/pod-kill.yaml` and watch the SLO board and `kubectl get pods -n freight -w`. `kubectl describe podchaos kill-one-cargo-api -n freight` shows which Pod was hit.', cost: 100 },
    { text: 'Harden: `kubectl scale deployment cargo-api --replicas=3 -n freight`; add a spread constraint with `kubectl edit deployment cargo-api -n freight` (`topologySpreadConstraints: [{maxSkew: 1, topologyKey: kubernetes.io/hostname, whenUnsatisfiable: ScheduleAnyway, labelSelector: {matchLabels: {app: cargo-api}}}]`); `kubectl create pdb cargo-api --selector=app=cargo-api --max-unavailable=1 -n freight`.', cost: 150 },
    { text: 'Repeat: `kubectl delete -f gameday/pod-kill.yaml`, `kubectl apply -f gameday/pod-kill.yaml`. This time two replicas keep answering. When infra cuts a node: `kubectl get nodes`, `kubectl get pods -n freight -o wide`.', cost: 120 },
  ],
  par: { timeSec: 600, commands: 12 }, timeLimitSec: 1200, slo: { minAvailability: 0.95 },
  solution: [
    'cat gameday/plan.md',
    'kubectl get pods -n freight -o wide',
    'kubectl apply -f gameday/pod-kill.yaml',
    'sleep 3',
    'kubectl describe podchaos kill-one-cargo-api -n freight',
    'kubectl get pods -n freight -o wide',
    'kubectl patch deployment cargo-api -n freight --type merge -p \'{"spec":{"replicas":3,"template":{"spec":{"topologySpreadConstraints":[{"maxSkew":1,"topologyKey":"kubernetes.io/hostname","whenUnsatisfiable":"ScheduleAnyway","labelSelector":{"matchLabels":{"app":"cargo-api"}},"matchLabelKeys":["pod-template-hash"]}]}}}}\'',
    'kubectl create pdb cargo-api --selector=app=cargo-api --max-unavailable=1 -n freight',
    'kubectl rollout status deployment/cargo-api -n freight',
    'kubectl get pods -n freight -o wide',
    'kubectl delete -f gameday/pod-kill.yaml',
    'kubectl apply -f gameday/pod-kill.yaml',
    'sleep 8',
    'kubectl get pods -n freight -o wide',
    'sleep 50',
    'kubectl get nodes',
    'kubectl get pods -n freight -o wide',
  ],
  debrief: { proTips: ['Automate the experiments you trust (Chaos Mesh Schedules and Workflows, LitmusChaos) and run them continuously in staging; keep production game days small, announced and supervised.', 'Chaos needs observability: without request-level metrics you only learn that Pods died, not what users saw. Continuous profilers (Parca, Pixie) and eBPF tools (Hubble, Tetragon) show the rest.', 'Write down each hypothesis and result. A failed hypothesis with a fix is the most valuable artefact a game day produces.'] },
};

export const chapter8: Mission[] = [m8_1, m8_2, m8_3];
