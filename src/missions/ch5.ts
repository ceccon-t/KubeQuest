/** Chapter 5 — Configuration, state and security. */
import type { Mission, ObjectiveContext } from '../game/mission.ts';
import { ORBITAL_IMAGES, REG, deployment, service, orbitalNodes, systemWorkloads, usedCmd } from './lib.ts';
import { storageClass } from './platform.ts';
import type { ConfigMap, Secret, KubeObject, PersistentVolumeClaim, StatefulSet, Service, Namespace, Pod, Container, PodSpec } from '../engine/types.ts';
import { b64decode } from '../engine/encoding.ts';
import { authorize, serviceAccountUser } from '../engine/rbac.ts';
import { checkPodSecurity } from '../engine/podsecurity.ts';
import { admit } from '../engine/admission.ts';
import { ApiError } from '../engine/store.ts';
import { isPodReady } from '../engine/controllers/kubelet.ts';

const ns = (name: string, labels: Record<string, string> = {}, age = 30 * 86400): { ageSeconds: number; object: KubeObject } => ({ ageSeconds: age, object: { apiVersion: 'v1', kind: 'Namespace', metadata: { name, labels } } });
const stderrHad = (c: ObjectiveContext, re: RegExp): boolean => c.history.some((h) => re.test(h.stderr));
const container = (c: ObjectiveContext, nsName: string, deploy: string): Container | undefined => c.view.deployment(nsName, deploy)?.spec.template.spec.containers[0];
const can = (c: ObjectiveContext, nsName: string, sa: string, verb: string, resource: string, inNs: string | undefined, group = ''): boolean => authorize(c.engine, serviceAccountUser(nsName, sa), { verb, group, resource, namespace: inNs });

// ---------------------------------------------------------------------------
// 5.1 ConfigMaps & Secrets
// ---------------------------------------------------------------------------

const NOTIFIER_YAML = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: notifier
  namespace: freight
  labels:
    app: notifier
spec:
  replicas: 2
  selector:
    matchLabels:
      app: notifier
  template:
    metadata:
      labels:
        app: notifier
    spec:
      containers:
      - name: notifier
        image: ${REG}/notifier:1.4.0
        ports:
        - containerPort: 8080
`;
const SMTP = 's3ndgr1d-0rbital';
const liveMode = (c: ObjectiveContext): string[] => c.view.readyPods('freight', 'app=notifier').map((p) => c.engine.podRuntime(p).containers[0]?.env.NOTIFY_MODE ?? '');

export const m5_1: Mission = {
  id: '5.1', chapter: 5, order: 1, title: 'Config is not code', tagline: 'ConfigMaps, Secrets, and what a running Pod actually sees.',
  ticket: {
    from: 'Ana (team-notify)', priority: 'P2', subject: 'notifier 1.4.0 crash-loops: it wants its configuration from the cluster',
    body: [
      'notifier 1.4.0 no longer has settings baked into the image. It needs: env `NOTIFY_MODE` (use `batch`), env `SMTP_PASSWORD`, and the file `/etc/notifier/templates.yaml`.',
      'House rules: non-secret settings in a ConfigMap `notifier-config` (key `mode`), the templates file in a ConfigMap `notifier-templates` (source: ~/config/templates.yaml), the password in a Secret `smtp-credentials` (key `password`). The password is `' + SMTP + '`. No literal values in the Deployment.',
      'The Deployment manifest is ~/manifests/notifier.yaml. Stay around after it is green: product has a change coming.',
    ],
  },
  concepts: [
    { title: 'ConfigMap: configuration as an object', body: 'A **ConfigMap** holds key/value pairs or whole files, separate from the image. A Pod consumes it as environment variables (`valueFrom.configMapKeyRef`, or `envFrom` for all keys) or as files through a volume. Same image, different config per environment.', example: 'kubectl create configmap notifier-config --from-literal=mode=batch -n freight\nkubectl create configmap notifier-templates --from-file=config/templates.yaml -n freight' },
    { title: 'Secret: same shape, different handling', body: 'A **Secret** is consumed exactly like a ConfigMap (`secretKeyRef`, volume). Values are base64-**encoded**, not encrypted: anyone who may read the Secret reads the password. Its protection is RBAC, encryption at rest, and never committing it to git.', example: "kubectl create secret generic smtp-credentials --from-literal=password=… -n freight\nkubectl get secret smtp-credentials -o jsonpath='{.data.password}' | base64 -d" },
    { title: 'Env is a snapshot, files follow', body: 'Environment variables are read once, when the container starts: changing the ConfigMap does not change running Pods — restart them (`kubectl rollout restart`). Mounted files are refreshed by the kubelet within about a minute, if the application re-reads them.', example: 'kubectl rollout restart deployment/notifier -n freight' },
  ],
  cluster: {
    seed: 61, nodes: orbitalNodes(), namespaces: ['freight'], images: ORBITAL_IMAGES,
    objects: [
      ...systemWorkloads(),
      { ageSeconds: 900, object: deployment({ name: 'notifier', ns: 'freight', image: `${REG}/notifier:1.4.0`, replicas: 2, port: 8080 }) },
      { ageSeconds: 3 * 86400, object: deployment({ name: 'frontend', ns: 'freight', image: `${REG}/frontend:1.4.0`, replicas: 2, port: 8080 }) },
      { ageSeconds: 3 * 86400, object: service({ name: 'frontend', ns: 'freight', selector: { app: 'frontend' }, port: 80, targetPort: 8080 }) },
    ],
    traffic: [{ id: 'customers', service: 'freight/frontend', rps: 3, label: 'customers' }],
  },
  files: { 'manifests/notifier.yaml': NOTIFIER_YAML, 'config/templates.yaml': 'shipment_delayed:\n  subject: "Shipment {{id}} is delayed"\n  body: "New ETA: {{eta}}"\nshipment_arrived:\n  subject: "Shipment {{id}} has docked"\n' },
  objectives: [
    { id: 'config', text: 'ConfigMaps notifier-config (key mode) and notifier-templates (templates.yaml) exist', check: (c) => !!c.view.get<ConfigMap>('ConfigMap', 'freight', 'notifier-config')?.data?.mode && !!c.view.get<ConfigMap>('ConfigMap', 'freight', 'notifier-templates')?.data?.['templates.yaml'] },
    { id: 'secret', text: 'Secret smtp-credentials holds the password', check: (c) => b64decode(c.view.get<Secret>('Secret', 'freight', 'smtp-credentials')?.data?.password ?? '') === SMTP },
    { id: 'wire', text: 'The Deployment takes both env vars by reference and mounts the templates at /etc/notifier', check: (c) => {
      const ct = container(c, 'freight', 'notifier');
      const spec = c.view.deployment('freight', 'notifier')?.spec.template.spec;
      const env = (n: string) => ct?.env?.find((e) => e.name === n)?.valueFrom;
      const viaEnvFrom = (kind: 'configMapRef' | 'secretRef', name: string) => !!ct?.envFrom?.some((e) => e[kind]?.name === name);
      const mount = ct?.volumeMounts?.find((m) => m.mountPath.replace(/\/$/, '') === '/etc/notifier');
      return (env('NOTIFY_MODE')?.configMapKeyRef?.name === 'notifier-config' || viaEnvFrom('configMapRef', 'notifier-config')) && (env('SMTP_PASSWORD')?.secretKeyRef?.name === 'smtp-credentials' || viaEnvFrom('secretRef', 'smtp-credentials')) && !!mount && !!spec?.volumes?.some((v) => v.name === mount.name && v.configMap?.name === 'notifier-templates');
    } },
    { id: 'ready', text: 'notifier is 2/2 ready', check: (c) => c.view.deploymentReady('freight', 'notifier', 2) },
    { id: 'live', text: 'Product wants `realtime`: change the ConfigMap and make the running Pods use it', revealAfter: 'ready', check: (c) => c.flags.has('mode-change') && c.view.get<ConfigMap>('ConfigMap', 'freight', 'notifier-config')?.data?.mode === 'realtime' && c.view.deploymentReady('freight', 'notifier', 2) && liveMode(c).length === 2 && liveMode(c).every((m) => m === 'realtime') },
    { id: 'decode', text: 'Bonus: read the password back out of the Secret', optional: true, check: (c) => c.history.some((h) => /base64/.test(h.line) && h.stdout.includes(SMTP)) },
  ],
  chaos: [
    { id: 'mode-change', at: { afterObjective: 'ready', delaySeconds: 6 }, action: { type: 'flag', flag: 'mode-change' }, announce: { from: 'Ana (team-notify)', text: 'Product decision: notifications go out in real time from now. Set mode to `realtime` in notifier-config — no new image, please.' } },
  ],
  hints: [
    { text: '`kubectl logs deploy/notifier -n freight --previous` names what is missing. Create the three objects: `kubectl create configmap notifier-config --from-literal=mode=batch -n freight`, `kubectl create configmap notifier-templates --from-file=config/templates.yaml -n freight`, `kubectl create secret generic smtp-credentials --from-literal=password=… -n freight`.', cost: 100 },
    { text: 'In manifests/notifier.yaml, under the container: `env:` with `- name: NOTIFY_MODE` / `valueFrom: {configMapKeyRef: {name: notifier-config, key: mode}}` and the same with `secretKeyRef` for SMTP_PASSWORD; `volumeMounts: [{name: templates, mountPath: /etc/notifier}]`; and at Pod level `volumes: [{name: templates, configMap: {name: notifier-templates}}]`. Apply.', cost: 150 },
    { text: 'For the change: `kubectl patch configmap notifier-config -n freight -p \'{"data":{"mode":"realtime"}}\'` (or `kubectl edit`). The Pods still say `batch` — env is read at start. `kubectl rollout restart deployment/notifier -n freight`.', cost: 150 },
  ],
  par: { timeSec: 480, commands: 10 }, timeLimitSec: 900,
  solution: [
    'kubectl logs deploy/notifier -n freight --previous',
    'kubectl create configmap notifier-config --from-literal=mode=batch -n freight',
    'kubectl create configmap notifier-templates --from-file=config/templates.yaml -n freight',
    `kubectl create secret generic smtp-credentials --from-literal=password=${SMTP} -n freight`,
    { edit: 'manifests/notifier.yaml', replace: ['        ports:\n        - containerPort: 8080\n', '        ports:\n        - containerPort: 8080\n        env:\n        - name: NOTIFY_MODE\n          valueFrom:\n            configMapKeyRef:\n              name: notifier-config\n              key: mode\n        - name: SMTP_PASSWORD\n          valueFrom:\n            secretKeyRef:\n              name: smtp-credentials\n              key: password\n        volumeMounts:\n        - name: templates\n          mountPath: /etc/notifier\n      volumes:\n      - name: templates\n        configMap:\n          name: notifier-templates\n'] },
    'kubectl apply -f manifests/notifier.yaml',
    'kubectl rollout status deployment/notifier -n freight',
    "kubectl get secret smtp-credentials -n freight -o jsonpath='{.data.password}' | base64 -d",
    'sleep 8',
    'kubectl patch configmap notifier-config -n freight -p \'{"data":{"mode":"realtime"}}\'',
    'kubectl rollout restart deployment/notifier -n freight',
    'kubectl rollout status deployment/notifier -n freight',
  ],
  debrief: { proTips: ['Native Secrets are only as safe as etcd and RBAC. Real platforms keep the source of truth outside: External Secrets Operator or the Secrets Store CSI Driver sync from Vault or a cloud secret manager; Sealed Secrets lets you commit an encrypted form to git.', 'Kustomize\'s `configMapGenerator` appends a content hash to the name, so every config change is a new name and triggers a rollout by itself — Chapter 7.', '`immutable: true` on a ConfigMap or Secret protects it from edits and saves the kubelet from watching it.'] },
};

// ---------------------------------------------------------------------------
// 5.2 Persistent storage
// ---------------------------------------------------------------------------

const LEDGER_YAML = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: ledger
  namespace: freight
  labels:
    app: ledger
spec:
  replicas: 1
  strategy:
    type: Recreate
  selector:
    matchLabels:
      app: ledger
  template:
    metadata:
      labels:
        app: ledger
    spec:
      containers:
      - name: ledger
        image: ${REG}/ledger:2.0
        ports:
        - containerPort: 8080
`;
const LEDGER_PVC = `apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: ledger-data
  namespace: freight
spec:
  accessModes:
  - ReadWriteOnce
  storageClassName: fast-ssd
  resources:
    requests:
      storage: 5Gi
`;

export const m5_2: Mission = {
  id: '5.2', chapter: 5, order: 2, title: 'Data that outlives the Pod', tagline: 'PersistentVolumeClaims, StorageClasses and a claim that never binds.',
  ticket: {
    from: 'Finance (Tomasz)', priority: 'P2', subject: 'The freight ledger forgets everything whenever its pod restarts',
    body: [
      'Last night\'s node reboot wiped a day of ledger entries. The ledger writes to /var/lib/ledger inside its container and nothing more.',
      'Give it durable storage: a PersistentVolumeClaim `ledger-data` (5Gi, ReadWriteOnce) mounted at /var/lib/ledger. A colleague left a claim manifest in ~/manifests/ledger-pvc.yaml before going on leave; the Deployment is ~/manifests/ledger.yaml.',
      'Then prove it to me: delete the pod and show the entries are still there.',
    ],
  },
  concepts: [
    { title: 'Claim, class, volume', body: 'A **PersistentVolumeClaim** asks for storage (size, access mode, class). A **StorageClass** names a provisioner — a CSI driver — that creates a **PersistentVolume** on demand and binds it to the claim. The Pod only references the claim; the data lives in the volume and outlives any Pod.', example: 'kubectl get sc\nkubectl get pvc,pv -n freight' },
    { title: 'Pending claims', body: 'A claim stays `Pending` when its class does not exist, the provisioner fails, or the class waits for a first consumer (`WaitForFirstConsumer`). `kubectl describe pvc` shows the events. A Pod using an unbound immediate claim is unschedulable. Most claim fields are immutable: fix by deleting and recreating.', example: 'kubectl describe pvc ledger-data -n freight' },
    { title: 'Access modes and reclaim', body: '`ReadWriteOnce` mounts on one node at a time — fine for a single writer, and the reason single-replica stateful Deployments use `strategy: Recreate`. The class\'s `reclaimPolicy` decides what happens to the volume when the claim is deleted: `Delete` destroys the data, `Retain` keeps it.', example: 'volumes:\n- name: data\n  persistentVolumeClaim:\n    claimName: ledger-data' },
  ],
  cluster: {
    seed: 62, nodes: orbitalNodes(), namespaces: ['freight'], images: ORBITAL_IMAGES,
    objects: [
      ...systemWorkloads(), storageClass('ceph-block', { isDefault: true }), storageClass('ceph-bulk', { reclaimPolicy: 'Retain' }),
      { ageSeconds: 6 * 3600, object: deployment({ name: 'ledger', ns: 'freight', image: `${REG}/ledger:2.0`, replicas: 1, port: 8080, strategy: { type: 'Recreate' } }) },
      { ageSeconds: 6 * 3600, object: service({ name: 'ledger', ns: 'freight', selector: { app: 'ledger' }, port: 80, targetPort: 8080 }) },
    ],
  },
  files: { 'manifests/ledger.yaml': LEDGER_YAML, 'manifests/ledger-pvc.yaml': LEDGER_PVC },
  objectives: [
    { id: 'why', text: 'Find out why the claim from the manifest stays Pending', check: (c) => c.history.some((h) => /storageclass\.storage\.k8s\.io "fast-ssd" not found/.test(h.stdout)) },
    { id: 'classes', text: 'List the StorageClasses the cluster offers', check: (c) => usedCmd(c, /^kubectl (get|describe) (sc|storageclass(es)?)\b/) },
    { id: 'bound', text: 'Claim ledger-data (5Gi) is Bound', check: (c) => { const p = c.view.get<PersistentVolumeClaim>('PersistentVolumeClaim', 'freight', 'ledger-data'); return p?.status?.phase === 'Bound' && p.spec.resources?.requests?.storage === '5Gi'; } },
    { id: 'mounted', text: 'The ledger mounts the claim at /var/lib/ledger and is ready', check: (c) => { const spec = c.view.deployment('freight', 'ledger')?.spec.template.spec; const m = spec?.containers[0]?.volumeMounts?.find((x) => x.mountPath.replace(/\/$/, '') === '/var/lib/ledger'); return !!m && !!spec?.volumes?.some((v) => v.name === m.name && v.persistentVolumeClaim?.claimName === 'ledger-data') && c.view.deploymentReady('freight', 'ledger', 1); } },
    { id: 'survive', text: 'Delete the ledger pod and show the new one recovered its entries', revealAfter: 'mounted', check: (c) => usedCmd(c, /^kubectl delete (pods?|po)[ /]/) && c.history.some((h) => /^(kubectl|k) logs\b/.test(h.line) && /recovered [1-9]\d* entries/.test(h.stdout)) && c.view.deploymentReady('freight', 'ledger', 1) },
  ],
  hints: [
    { text: '`kubectl apply -f manifests/ledger-pvc.yaml`, then `kubectl get pvc -n freight` (Pending) and `kubectl describe pvc ledger-data -n freight`: the event names a StorageClass. Compare with `kubectl get sc`.', cost: 100 },
    { text: 'The class `fast-ssd` does not exist here. `storageClassName` cannot be edited on an existing claim: `kubectl delete -f manifests/ledger-pvc.yaml`, change it to `ceph-block` (or remove the line to get the default class), apply again.', cost: 120 },
    { text: 'In manifests/ledger.yaml add `volumeMounts: [{name: data, mountPath: /var/lib/ledger}]` to the container and `volumes: [{name: data, persistentVolumeClaim: {claimName: ledger-data}}]` to the Pod spec; apply. Later: `kubectl delete pod -l app=ledger -n freight`, then `kubectl logs deploy/ledger -n freight`.', cost: 150 },
  ],
  par: { timeSec: 480, commands: 15 }, timeLimitSec: 900,
  solution: [
    'kubectl logs deploy/ledger -n freight',
    'kubectl apply -f manifests/ledger-pvc.yaml',
    'sleep 2',
    'kubectl get pvc -n freight',
    'kubectl describe pvc ledger-data -n freight',
    'kubectl get sc',
    'kubectl delete -f manifests/ledger-pvc.yaml',
    { edit: 'manifests/ledger-pvc.yaml', replace: ['  storageClassName: fast-ssd\n', '  storageClassName: ceph-block\n'] },
    'kubectl apply -f manifests/ledger-pvc.yaml',
    { edit: 'manifests/ledger.yaml', replace: ['        ports:\n        - containerPort: 8080\n', '        ports:\n        - containerPort: 8080\n        volumeMounts:\n        - name: data\n          mountPath: /var/lib/ledger\n      volumes:\n      - name: data\n        persistentVolumeClaim:\n          claimName: ledger-data\n'] },
    'kubectl apply -f manifests/ledger.yaml',
    'kubectl rollout status deployment/ledger -n freight',
    'sleep 10',
    'kubectl delete pod -l app=ledger -n freight',
    'sleep 8',
    'kubectl logs deploy/ledger -n freight',
  ],
  debrief: { proTips: ['VolumeSnapshots (CSI) take point-in-time copies of a claim; Velero backs up both objects and volumes for disaster recovery.', '`allowVolumeExpansion: true` on the class lets you grow a claim by editing `spec.resources.requests.storage` — never shrink.', 'Generic ephemeral volumes give a Pod scratch space from a StorageClass that is deleted with the Pod, when `emptyDir` on the node disk is not enough.'] },
};

// ---------------------------------------------------------------------------
// 5.3 StatefulSets
// ---------------------------------------------------------------------------

const routecache = (replicas: number): KubeObject => ({
  apiVersion: 'apps/v1', kind: 'StatefulSet', metadata: { name: 'routecache', namespace: 'freight', labels: { app: 'routecache' } },
  spec: { serviceName: 'routecache', replicas, selector: { matchLabels: { app: 'routecache' } }, template: { metadata: { labels: { app: 'routecache' } }, spec: { containers: [{ name: 'redis', image: 'redis:7', ports: [{ containerPort: 6379, name: 'redis' }], volumeMounts: [{ name: 'data', mountPath: '/data' }] }] } }, volumeClaimTemplates: [{ apiVersion: 'v1', kind: 'PersistentVolumeClaim', metadata: { name: 'data' }, spec: { accessModes: ['ReadWriteOnce'], resources: { requests: { storage: '1Gi' } } } }] },
  status: { replicas: 0 },
});

export const m5_3: Mission = {
  id: '5.3', chapter: 5, order: 3, title: 'Pets with names', tagline: 'StatefulSets: stable identity, ordered rollout, one disk each.',
  ticket: {
    from: 'PagerDuty → planner-worker', priority: 'P2', subject: 'planner-worker cannot find routecache-0.routecache',
    body: [
      'The new route cache went live yesterday as a StatefulSet `routecache` (3 Redis members, one disk each). The planner-worker is configured with the primary\'s stable address, `routecache-0.routecache:6379`, and crash-loops with a DNS error.',
      'The pods are all Running. Whoever applied the StatefulSet forgot something it needs for those per-pod names. Fix that, get planner-worker healthy.',
      'Then scale the cache to 5 members for the weekend, and convince yourself a member keeps its name and its disk when its pod is replaced.',
    ],
  },
  concepts: [
    { title: 'StatefulSet = identity', body: 'A StatefulSet gives each Pod an ordinal name (`routecache-0`, `-1`, …) that survives rescheduling, creates them in order, and — with `volumeClaimTemplates` — binds one PersistentVolumeClaim per ordinal (`data-routecache-0`). Replace the Pod and it comes back with the same name and the same disk.', example: 'kubectl get sts,pods,pvc -n freight -l app=routecache' },
    { title: 'Headless Service', body: '`spec.serviceName` must point at a **headless** Service (`clusterIP: None`). It has no virtual IP; instead DNS returns the Pod IPs and gives every member its own record: `POD.SERVICE.NAMESPACE.svc.cluster.local`. Without that Service the Pods run, but their names do not resolve.', example: 'kubectl create service clusterip routecache --clusterip=None --tcp=6379:6379 -n freight' },
    { title: 'Ordered operations', body: 'Scale-up goes 0→N one Pod at a time, each waiting for the previous to be Ready; scale-down and rolling updates go in reverse. Scaling down does **not** delete the claims — data waits for the member to return.', example: 'kubectl scale sts routecache --replicas=5 -n freight\nkubectl rollout status sts/routecache -n freight' },
  ],
  cluster: {
    seed: 63, nodes: orbitalNodes(), namespaces: ['freight'], images: ORBITAL_IMAGES,
    objects: [
      ...systemWorkloads(), storageClass('ceph-block', { isDefault: true }),
      { ageSeconds: 86400, object: routecache(3) },
      { ageSeconds: 3600, object: deployment({ name: 'planner-worker', ns: 'freight', image: `${REG}/planner-worker:1.1.0`, replicas: 2, port: 8080 }) },
      { ageSeconds: 3600, object: { apiVersion: 'v1', kind: 'Pod', metadata: { name: 'tools', namespace: 'freight', labels: { run: 'tools' } }, spec: { containers: [{ name: 'tools', image: `${REG}/debug:1.0` }] }, status: {} } },
    ],
  },
  objectives: [
    { id: 'diagnose', text: 'Read the planner-worker error', check: (c) => c.history.some((h) => /^(kubectl|k) logs\b/.test(h.line) && /routecache-0\.routecache.*no such host/.test(h.stdout)) },
    { id: 'headless', text: 'Headless Service routecache exists and selects the cache pods', check: (c) => { const s = c.view.get<Service>('Service', 'freight', 'routecache'); return s?.spec.clusterIP === 'None' && c.view.endpointsReady('freight', 'routecache') >= 3; } },
    { id: 'worker', text: 'planner-worker is 2/2 ready', check: (c) => c.view.deploymentReady('freight', 'planner-worker', 2) },
    { id: 'scale', text: 'routecache has 5 ready members, each with its own Bound claim', check: (c) => { const s = c.view.get<StatefulSet>('StatefulSet', 'freight', 'routecache'); return s?.spec.replicas === 5 && s.status.readyReplicas === 5 && [0, 1, 2, 3, 4].every((i) => c.view.get<PersistentVolumeClaim>('PersistentVolumeClaim', 'freight', `data-routecache-${i}`)?.status?.phase === 'Bound'); } },
    { id: 'identity', text: 'Delete routecache-1: it returns with the same name and the same claim', revealAfter: 'scale', check: (c) => { const del = c.history.find((h) => /^(kubectl|k) delete (pods?|po)[ /]routecache-1\b/.test(h.line) && h.code === 0); const p = c.view.pod('freight', 'routecache-1'); return !!del && !!p && isPodReady(p) && Date.parse(p.metadata.creationTimestamp ?? '') >= del.at - 1000 /* timestamps have second resolution */ && !!p.spec.volumes?.some((v) => v.persistentVolumeClaim?.claimName === 'data-routecache-1'); } },
    { id: 'dns', text: 'Bonus: resolve a member by name from the tools pod', optional: true, check: (c) => c.history.some((h) => /nslookup\s+routecache-\d\.routecache/.test(h.line) && /Address: 10\./.test(h.stdout)) },
  ],
  hints: [
    { text: '`kubectl logs deploy/planner-worker -n freight --previous`: a DNS lookup fails. `kubectl get sts routecache -n freight -o yaml | grep serviceName` and `kubectl get svc -n freight`: the Service it names is not there.', cost: 100 },
    { text: 'Create the headless Service: `kubectl create service clusterip routecache --clusterip=None --tcp=6379:6379 -n freight` (its selector is `app=routecache`). Then `kubectl rollout restart deployment/planner-worker -n freight` so it does not wait out its crash back-off.', cost: 150 },
    { text: '`kubectl scale sts routecache --replicas=5 -n freight` and watch `kubectl get pods,pvc -n freight`: -3 then -4, each with a new claim. Finally `kubectl delete pod routecache-1 -n freight` and look again.', cost: 120 },
  ],
  par: { timeSec: 480, commands: 10 }, timeLimitSec: 900,
  solution: [
    'kubectl get pods,sts,svc -n freight',
    'kubectl logs deploy/planner-worker -n freight --previous',
    'kubectl create service clusterip routecache --clusterip=None --tcp=6379:6379 -n freight',
    'sleep 2',
    'kubectl exec tools -n freight -- nslookup routecache-0.routecache',
    'kubectl rollout restart deployment/planner-worker -n freight',
    'kubectl rollout status deployment/planner-worker -n freight',
    'kubectl scale sts routecache --replicas=5 -n freight',
    'kubectl rollout status sts/routecache -n freight',
    'kubectl get pods,pvc -n freight',
    'kubectl delete pod routecache-1 -n freight',
    'sleep 10',
    'kubectl get pods -n freight -l app=routecache',
  ],
  debrief: { proTips: ['Running a real database this way still leaves replication, failover and backups to you — that is what operators (CloudNativePG, Strimzi, the Redis operator) automate. Chapter 7.', '`podManagementPolicy: Parallel` starts all members at once when they do not depend on each other.', '`persistentVolumeClaimRetentionPolicy` can delete claims on scale-down or StatefulSet deletion; the default keeps them.'] },
};

// ---------------------------------------------------------------------------
// 5.4 RBAC
// ---------------------------------------------------------------------------

export const m5_4: Mission = {
  id: '5.4', chapter: 5, order: 4, title: 'Least privilege', tagline: 'ServiceAccounts, Roles, bindings — and removing a cluster-admin shortcut.',
  ticket: {
    from: 'Kenji (Security)', priority: 'P2', subject: 'Audit: the default ServiceAccount in freight is cluster-admin',
    body: [
      'Somebody made the fleet-agent work last month by binding `cluster-admin` to the `default` ServiceAccount of freight (ClusterRoleBinding `fleet-agent-temp-fix`). Every pod in that namespace can now delete nodes and read every Secret in the cluster.',
      'The agent only needs to list and watch Pods in freight. Give it its own ServiceAccount `fleet-agent` with exactly that, switch the Deployment over, then remove the shortcut.',
      'The inventory dashboard reads from the agent all day. Do it in an order that never leaves the agent without access.',
    ],
  },
  concepts: [
    { title: 'Who, what, where', body: 'RBAC answers three questions. **Subject**: a user, group or ServiceAccount (`system:serviceaccount:NAMESPACE:NAME`). **Role** / **ClusterRole**: verbs on resources. **RoleBinding** / **ClusterRoleBinding**: grants a role to subjects — inside one namespace, or everywhere. There are no deny rules; access is the sum of all grants.', example: 'kubectl create role pod-reader --verb=get,list,watch --resource=pods -n freight\nkubectl create rolebinding agent-reads --role=pod-reader --serviceaccount=freight:fleet-agent -n freight' },
    { title: 'ServiceAccounts are identities for Pods', body: 'Every Pod runs as a ServiceAccount (`default` unless `serviceAccountName` says otherwise) and gets its token mounted. Whatever is bound to that account, every Pod using it can do — so one account per workload, with only what it needs.', example: 'kubectl create serviceaccount fleet-agent -n freight\nkubectl set serviceaccount deployment/fleet-agent fleet-agent -n freight' },
    { title: 'Ask the authorizer', body: '`kubectl auth can-i VERB RESOURCE --as=SUBJECT` asks the API server what a subject may do; `--list` prints everything. Use it before and after every RBAC change — it is the unit test of access control.', example: 'kubectl auth can-i delete nodes --as=system:serviceaccount:freight:default\nkubectl auth can-i --list -n freight --as=system:serviceaccount:freight:fleet-agent' },
  ],
  cluster: {
    seed: 64, nodes: orbitalNodes(), namespaces: ['freight'], images: ORBITAL_IMAGES,
    objects: [
      ...systemWorkloads(),
      { ageSeconds: 30 * 86400, object: { apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'ClusterRoleBinding', metadata: { name: 'fleet-agent-temp-fix', annotations: { note: 'TEMPORARY - remove after the demo' } }, roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: 'cluster-admin' }, subjects: [{ kind: 'ServiceAccount', name: 'default', namespace: 'freight' }] } },
      { ageSeconds: 29 * 86400, object: deployment({ name: 'fleet-agent', ns: 'freight', image: `${REG}/fleet-agent:0.8.0`, replicas: 2, port: 8080, readinessProbe: { httpGet: { path: '/readyz', port: 8080 }, periodSeconds: 5 } }) },
      { ageSeconds: 29 * 86400, object: service({ name: 'fleet-agent', ns: 'freight', selector: { app: 'fleet-agent' }, port: 80, targetPort: 8080 }) },
      { ageSeconds: 3 * 86400, object: deployment({ name: 'frontend', ns: 'freight', image: `${REG}/frontend:1.4.0`, replicas: 2, port: 8080 }) },
    ],
    traffic: [{ id: 'dashboard', service: 'freight/fleet-agent', rps: 6, label: 'inventory dashboard' }],
  },
  objectives: [
    { id: 'audit', text: 'Confirm what the default ServiceAccount of freight may do (kubectl auth can-i --as)', check: (c) => c.history.some((h) => /^(kubectl|k) auth can-i\b.*--as[= ]system:serviceaccount:freight:default/.test(h.line) && /(^|\n)yes\b|\*\.\*/.test(h.stdout)) },
    { id: 'grant', text: 'ServiceAccount fleet-agent may get/list/watch pods in freight — and nothing more', check: (c) => !!c.view.get('ServiceAccount', 'freight', 'fleet-agent') && ['get', 'list', 'watch'].every((v) => can(c, 'freight', 'fleet-agent', v, 'pods', 'freight')) && !can(c, 'freight', 'fleet-agent', 'delete', 'pods', 'freight') && !can(c, 'freight', 'fleet-agent', 'get', 'secrets', 'freight') && !can(c, 'freight', 'fleet-agent', 'list', 'pods', 'kube-system') },
    { id: 'switch', text: 'The fleet-agent Deployment runs as that ServiceAccount, 2/2 ready', check: (c) => c.view.deployment('freight', 'fleet-agent')?.spec.template.spec.serviceAccountName === 'fleet-agent' && c.view.deploymentReady('freight', 'fleet-agent', 2) },
    { id: 'revoke', text: 'The cluster-admin shortcut is gone: the default account can no longer read Secrets', check: (c) => !can(c, 'freight', 'default', 'get', 'secrets', 'freight') && !can(c, 'freight', 'default', 'delete', 'nodes', undefined) && c.view.deployment('freight', 'fleet-agent')?.spec.template.spec.serviceAccountName === 'fleet-agent' && c.view.deploymentReady('freight', 'fleet-agent', 2) },
    { id: 'verify', text: 'Bonus: verify the new account with kubectl auth can-i', optional: true, check: (c) => c.history.some((h) => /^(kubectl|k) auth can-i\b.*--as[= ]system:serviceaccount:freight:fleet-agent/.test(h.line)) },
  ],
  hints: [
    { text: '`kubectl auth can-i delete nodes --as=system:serviceaccount:freight:default` says yes. `kubectl get clusterrolebindings -o wide | grep freight` shows why. Do not delete it yet: the agent is using it.', cost: 100 },
    { text: 'Build the replacement first: `kubectl create serviceaccount fleet-agent -n freight`, `kubectl create role pod-reader --verb=get,list,watch --resource=pods -n freight`, `kubectl create rolebinding fleet-agent-pod-reader --role=pod-reader --serviceaccount=freight:fleet-agent -n freight`.', cost: 150 },
    { text: 'Switch: `kubectl set serviceaccount deployment/fleet-agent fleet-agent -n freight` and wait for `kubectl rollout status deployment/fleet-agent -n freight`. Only then `kubectl delete clusterrolebinding fleet-agent-temp-fix`.', cost: 150 },
  ],
  par: { timeSec: 420, commands: 10 }, timeLimitSec: 900, slo: { minAvailability: 0.97 },
  solution: [
    'kubectl auth can-i delete nodes --as=system:serviceaccount:freight:default',
    'kubectl get clusterrolebindings -o wide | grep freight',
    'kubectl create serviceaccount fleet-agent -n freight',
    'kubectl create role pod-reader --verb=get,list,watch --resource=pods -n freight',
    'kubectl create rolebinding fleet-agent-pod-reader --role=pod-reader --serviceaccount=freight:fleet-agent -n freight',
    'kubectl auth can-i list pods -n freight --as=system:serviceaccount:freight:fleet-agent',
    'kubectl set serviceaccount deployment/fleet-agent fleet-agent -n freight',
    'kubectl rollout status deployment/fleet-agent -n freight',
    'kubectl delete clusterrolebinding fleet-agent-temp-fix',
    'kubectl auth can-i get secrets -n freight --as=system:serviceaccount:freight:default',
  ],
  debrief: { proTips: ['A RoleBinding may reference a ClusterRole (`--clusterrole=view`): the permissions are defined once and granted per namespace.', 'Set `automountServiceAccountToken: false` on workloads that never call the API — no token, nothing to steal.', 'Humans get access the same way: groups from your identity provider bound to `view`, `edit` or `admin` per namespace.'] },
};

// ---------------------------------------------------------------------------
// 5.5 SecurityContext & Pod Security Admission
// ---------------------------------------------------------------------------

const CARGO_YAML = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: cargo-api
  namespace: freight
  labels:
    app: cargo-api
spec:
  replicas: 2
  selector:
    matchLabels:
      app: cargo-api
  template:
    metadata:
      labels:
        app: cargo-api
    spec:
      containers:
      - name: cargo-api
        image: ${REG}/cargo-api:2.3.0
        ports:
        - containerPort: 8080
        readinessProbe:
          httpGet:
            path: /readyz
            port: 8080
          periodSeconds: 5
`;
const restricted = (spec: PodSpec | undefined): boolean => !!spec && checkPodSecurity('restricted', spec).length === 0;

export const m5_5: Mission = {
  id: '5.5', chapter: 5, order: 5, title: 'Run as nobody', tagline: 'SecurityContext hardening and Pod Security Admission.',
  ticket: {
    from: 'Kenji (Security)', priority: 'P2', subject: 'freight goes to the Restricted Pod Security Standard on Friday',
    body: [
      'From Friday the freight namespace enforces `restricted`. Pods that do not comply will simply not be created — including replacements for the ones running now.',
      'Preview the damage first (a server-side dry run of the namespace label lists the offenders). Then harden cargo-api in ~/manifests/cargo-api.yaml: non-root, no privilege escalation, all capabilities dropped, RuntimeDefault seccomp, and a read-only root filesystem. The app runs as uid 10001 and writes a cache under /tmp.',
      'When it rolls out cleanly, set the enforce label for real. Traffic is live.',
    ],
  },
  concepts: [
    { title: 'securityContext', body: 'Per container (or Pod): `runAsNonRoot: true` refuses images that run as uid 0; `allowPrivilegeEscalation: false` blocks setuid tricks; `capabilities.drop: ["ALL"]` removes root\'s special powers; `seccompProfile.type: RuntimeDefault` filters syscalls; `readOnlyRootFilesystem: true` makes the image immutable at runtime — writable paths become explicit volumes.', example: 'securityContext:\n  runAsNonRoot: true\n  allowPrivilegeEscalation: false\n  readOnlyRootFilesystem: true\n  capabilities: {drop: ["ALL"]}\n  seccompProfile: {type: RuntimeDefault}' },
    { title: 'Pod Security Standards', body: 'Three levels: **Privileged** (anything), **Baseline** (no known privilege escalations: no privileged, hostNetwork, hostPath…), **Restricted** (Baseline plus the hardening above). **Pod Security Admission** applies a level per namespace through labels, in three modes: `enforce` (reject Pods), `warn` (tell the user), `audit` (log).', example: 'kubectl label ns freight pod-security.kubernetes.io/enforce=restricted' },
    { title: 'Enforce rejects Pods, not Deployments', body: 'A Deployment that violates the level is accepted; its ReplicaSet then fails to create Pods (`FailedCreate` events). That is why you preview: `kubectl label --dry-run=server` reports the existing Pods that would violate, without changing anything.', example: 'kubectl label --dry-run=server --overwrite ns freight pod-security.kubernetes.io/enforce=restricted' },
  ],
  cluster: {
    seed: 65, nodes: orbitalNodes(), namespaces: ['freight'], images: ORBITAL_IMAGES,
    objects: [
      ...systemWorkloads(),
      { ageSeconds: 2 * 86400, object: deployment({ name: 'cargo-api', ns: 'freight', image: `${REG}/cargo-api:2.3.0`, replicas: 2, port: 8080, readinessProbe: { httpGet: { path: '/readyz', port: 8080 }, periodSeconds: 5 } }) },
      { ageSeconds: 2 * 86400, object: service({ name: 'cargo-api', ns: 'freight', selector: { app: 'cargo-api' }, port: 80, targetPort: 8080 }) },
    ],
    traffic: [{ id: 'cargo', service: 'freight/cargo-api', path: '/api/cargo', rps: 8, label: 'cargo API' }],
  },
  files: { 'manifests/cargo-api.yaml': CARGO_YAML },
  objectives: [
    { id: 'preview', text: 'Preview the Restricted level with a server-side dry run of the namespace label', check: (c) => c.history.some((h) => /--dry-run[= ]server/.test(h.line) && /existing pods in namespace "freight" violate the new PodSecurity enforce level "restricted:latest"/.test(h.stderr)) },
    { id: 'harden', text: 'cargo-api meets Restricted and has a read-only root filesystem', check: (c) => restricted(c.view.deployment('freight', 'cargo-api')?.spec.template.spec) && container(c, 'freight', 'cargo-api')?.securityContext?.readOnlyRootFilesystem === true },
    { id: 'ready', text: 'cargo-api is 2/2 ready with the hardened template', check: (c) => restricted(c.view.deployment('freight', 'cargo-api')?.spec.template.spec) && container(c, 'freight', 'cargo-api')?.securityContext?.readOnlyRootFilesystem === true && c.view.deploymentReady('freight', 'cargo-api', 2) && c.view.pods('freight', 'app=cargo-api').every((p) => restricted(p.spec)) },
    { id: 'enforce', text: 'Namespace freight enforces restricted, and every pod in it complies', check: (c) => c.view.get<Namespace>('Namespace', undefined, 'freight')?.metadata.labels?.['pod-security.kubernetes.io/enforce'] === 'restricted' && c.view.pods('freight').length >= 2 && c.view.pods('freight').every((p: Pod) => restricted(p.spec)) && c.view.deploymentReady('freight', 'cargo-api', 2) },
    { id: 'reject', text: 'Bonus: try to start a plain nginx pod in freight and read the rejection', optional: true, check: (c) => stderrHad(c, /violates PodSecurity "restricted:latest"/) },
  ],
  hints: [
    { text: '`kubectl label --dry-run=server --overwrite ns freight pod-security.kubernetes.io/enforce=restricted` prints one warning per offending pod with the failed checks. Nothing is changed.', cost: 100 },
    { text: 'In manifests/cargo-api.yaml, under the container add `securityContext:` with `runAsNonRoot: true`, `allowPrivilegeEscalation: false`, `readOnlyRootFilesystem: true`, `capabilities: {drop: ["ALL"]}`, `seccompProfile: {type: RuntimeDefault}`. Apply and watch the rollout.', cost: 150 },
    { text: 'If new pods crash with "read-only file system": the app writes to /tmp. Add `volumeMounts: [{name: tmp, mountPath: /tmp}]` and `volumes: [{name: tmp, emptyDir: {}}]`. When 2/2: `kubectl label ns freight pod-security.kubernetes.io/enforce=restricted`.', cost: 150 },
  ],
  par: { timeSec: 480, commands: 8 }, timeLimitSec: 900, slo: { minAvailability: 0.98 },
  solution: [
    'kubectl label --dry-run=server --overwrite ns freight pod-security.kubernetes.io/enforce=restricted',
    { edit: 'manifests/cargo-api.yaml', replace: ['        readinessProbe:\n', '        securityContext:\n          runAsNonRoot: true\n          allowPrivilegeEscalation: false\n          readOnlyRootFilesystem: true\n          capabilities:\n            drop: ["ALL"]\n          seccompProfile:\n            type: RuntimeDefault\n        volumeMounts:\n        - name: tmp\n          mountPath: /tmp\n        readinessProbe:\n'] },
    { edit: 'manifests/cargo-api.yaml', replace: [/$/, '      volumes:\n      - name: tmp\n        emptyDir: {}\n'] },
    'kubectl apply -f manifests/cargo-api.yaml',
    'kubectl rollout status deployment/cargo-api -n freight',
    'kubectl label ns freight pod-security.kubernetes.io/enforce=restricted',
    'kubectl run intruder --image=nginx:1.27 -n freight',
    'kubectl get pods -n freight',
  ],
  debrief: { proTips: ['Roll a level out in three steps: `audit` and `warn` first, read the findings, then `enforce`. Pin `enforce-version` so a cluster upgrade does not tighten the rules under you.', 'Runtime security tools (Falco, Tetragon) watch what containers actually do; scanners (Trivy, kube-bench) check images and cluster settings against CIS benchmarks.', 'Pod Security Admission is deliberately simple. Anything finer — "only this registry", "must have these labels" — is a job for admission policies: next ticket.'] },
};

// ---------------------------------------------------------------------------
// 5.6 Admission policy
// ---------------------------------------------------------------------------

const GUARDRAILS = `apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingAdmissionPolicy
metadata:
  name: freight-guardrails
spec:
  failurePolicy: Fail
  matchConstraints:
    resourceRules:
    - apiGroups: ["apps"]
      apiVersions: ["v1"]
      operations: ["CREATE", "UPDATE"]
      resources: ["deployments"]
  validations:
  - expression: "object.spec.template.spec.containers.all(c, c.image.startsWith('registry.orbital.local/'))"
    message: "images must come from registry.orbital.local"
  - expression: "object.spec.template.spec.containers.all(c, !c.image.endsWith(':latest'))"
    message: "the :latest tag is not allowed"
---
apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingAdmissionPolicyBinding
metadata:
  name: freight-guardrails
spec:
  policyName: freight-guardrails
  validationActions: ["Warn"]
  matchResources:
    namespaceSelector:
      matchLabels:
        team: freight
`;
const probe = (nsName: string, image: string, replicas: number): KubeObject => ({ apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'kq-probe', namespace: nsName }, spec: { replicas, selector: { matchLabels: { app: 'kq-probe' } }, template: { metadata: { labels: { app: 'kq-probe' } }, spec: { containers: [{ name: 'c', image }] } } } });
const denied = (c: ObjectiveContext, o: KubeObject): boolean => { try { admit(c.engine, o, 'CREATE'); return false; } catch (e) { if (e instanceof ApiError) return true; throw e; } };

export const m5_6: Mission = {
  id: '5.6', chapter: 5, order: 6, title: 'Policy as code', tagline: 'A ValidatingAdmissionPolicy that says no before the cluster has to.',
  ticket: {
    from: 'Platform (Liang)', priority: 'P3', subject: 'Guardrails for freight Deployments',
    body: [
      'Two incidents this quarter: a moving `:latest` tag, and a Deployment scaled to 500 by a typo. We want the API server to refuse both. A draft ValidatingAdmissionPolicy is in ~/policies/guardrails.yaml — it only warns for now.',
      'Rules for Deployments in namespaces labelled `team=freight`: images only from `registry.orbital.local/`, never `:latest`, and at most 10 replicas (that one is missing from the draft).',
      'Try the draft in Warn mode, then switch it to Deny. Other teams\' namespaces must not be affected.',
    ],
  },
  concepts: [
    { title: 'Admission control', body: 'Every write to the API passes **admission** after authentication and authorization: plugins may mutate the object, then validate it. Quotas, Pod Security and your own policies all live here. A rejected request never reaches etcd — the cheapest place to stop a mistake.', example: 'kubectl get validatingadmissionpolicies,validatingadmissionpolicybindings' },
    { title: 'ValidatingAdmissionPolicy + CEL', body: 'A built-in policy type: `matchConstraints` choose resources and operations; each `validations[].expression` is a **CEL** expression over `object` (and `oldObject`, `request`) that must be true. A separate **Binding** activates it, scopes it (`namespaceSelector`) and picks `validationActions`: `Deny`, `Warn`, `Audit`.', example: 'expression: "object.spec.replicas <= 10"\nmessage: "at most 10 replicas"' },
    { title: 'In the real world: policy engines', body: '**Kyverno** and **OPA Gatekeeper** are admission webhooks with richer features: mutation, generation, background scans, and image **signature verification** (cosign/Sigstore) so only images your CI signed can run. CEL policies cover structural rules without running anything extra.', example: 'cosign verify --key cosign.pub registry.orbital.local/freight/frontend@sha256:…' },
  ],
  cluster: {
    seed: 66, nodes: orbitalNodes(), images: ORBITAL_IMAGES,
    objects: [
      ns('freight', { team: 'freight' }), ns('billing', { team: 'billing' }), ...systemWorkloads(),
      { ageSeconds: 3 * 86400, object: deployment({ name: 'frontend', ns: 'freight', image: `${REG}/frontend:1.4.0`, replicas: 3, port: 8080 }) },
      { ageSeconds: 9 * 86400, object: deployment({ name: 'invoicer', ns: 'billing', image: 'nginx:1.27', replicas: 2, port: 80 }) },
    ],
  },
  files: { 'policies/guardrails.yaml': GUARDRAILS },
  objectives: [
    { id: 'warn', text: 'Apply the draft and trigger one of its warnings', check: (c) => stderrHad(c, /Warning: Validation failed for ValidatingAdmissionPolicy 'freight-guardrails'/) },
    { id: 'deny', text: 'In freight, Deployments with a foreign image, :latest or more than 10 replicas are denied — valid ones are not', check: (c) => denied(c, probe('freight', 'nginx:1.27', 1)) && denied(c, probe('freight', 'registry.orbital.local/freight/frontend:latest', 1)) && denied(c, probe('freight', `${REG}/frontend:1.4.0`, 50)) && !denied(c, probe('freight', `${REG}/frontend:1.4.0`, 10)) },
    { id: 'scope', text: 'Other namespaces are not affected', check: (c) => denied(c, probe('freight', 'nginx:1.27', 1)) && !denied(c, probe('billing', 'nginx:latest', 50)) },
    { id: 'seen', text: 'See a denial with your own eyes', check: (c) => stderrHad(c, /ValidatingAdmissionPolicy 'freight-guardrails' with binding '[^']+' denied request/) },
  ],
  hints: [
    { text: '`kubectl apply -f policies/guardrails.yaml`, then try something it dislikes: `kubectl create deployment probe --image=nginx:latest -n freight`. In Warn mode the object is created and you get a `Warning:` line. Clean up: `kubectl delete deployment probe -n freight`.', cost: 100 },
    { text: 'Edit the file: add a third validation — `- expression: "object.spec.replicas <= 10"` with a `message` — and change `validationActions` to `["Deny"]`. Apply again.', cost: 150 },
    { text: 'Test both ways: `kubectl create deployment probe --image=nginx:latest -n freight` (denied), `kubectl scale deployment frontend --replicas=50 -n freight` (denied), `kubectl scale deployment frontend --replicas=4 -n freight` (fine).', cost: 120 },
  ],
  par: { timeSec: 420, commands: 9 }, timeLimitSec: 900,
  solution: [
    'cat policies/guardrails.yaml',
    'kubectl apply -f policies/guardrails.yaml',
    'kubectl create deployment probe --image=nginx:latest -n freight',
    'kubectl delete deployment probe -n freight',
    { edit: 'policies/guardrails.yaml', replace: ['  validationActions: ["Warn"]\n', '  validationActions: ["Deny"]\n'] },
    { edit: 'policies/guardrails.yaml', replace: ['    message: "the :latest tag is not allowed"\n', '    message: "the :latest tag is not allowed"\n  - expression: "object.spec.replicas <= 10"\n    message: "at most 10 replicas per Deployment"\n'] },
    'kubectl apply -f policies/guardrails.yaml',
    'kubectl create deployment probe --image=nginx:latest -n freight',
    'kubectl scale deployment frontend --replicas=50 -n freight',
    'kubectl scale deployment frontend --replicas=4 -n freight',
  ],
  debrief: { proTips: ['Supply-chain security in one line each: build provenance (SLSA), a bill of materials (SBOM), a signature (cosign), and an admission rule that verifies it — policy is where the chain is enforced.', 'Roll out a new rule as `Audit` or `Warn` first and read the results; `Deny` on day one breaks deploys you did not know existed.', 'Policies can take parameters (`paramKind`) so one policy serves many teams with different limits.'] },
};

// ---------------------------------------------------------------------------
// 5.7 Capstone
// ---------------------------------------------------------------------------

const VAULT_LEDGER = `apiVersion: v1
kind: Service
metadata:
  name: ledger
  namespace: vault
spec:
  clusterIP: None
  selector:
    app: ledger
  ports:
  - name: http
    port: 8080
---
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: ledger
  namespace: vault
spec:
  serviceName: ledger
  replicas: 3
  selector:
    matchLabels:
      app: ledger
  template:
    metadata:
      labels:
        app: ledger
    spec:
      serviceAccountName: ledger
      containers:
      - name: ledger
        image: registry.orbital.local/secure/ledger:2.0
        ports:
        - containerPort: 8080
        readinessProbe:
          httpGet:
            path: /readyz
            port: 8080
          periodSeconds: 5
`;
const TRUSTED = `apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingAdmissionPolicy
metadata:
  name: vault-trusted-images
spec:
  failurePolicy: Fail
  matchConstraints:
    resourceRules:
    - apiGroups: ["apps"]
      apiVersions: ["v1"]
      operations: ["CREATE", "UPDATE"]
      resources: ["statefulsets", "deployments"]
  validations:
  - expression: "object.spec.template.spec.containers.all(c, c.image.startsWith('registry.orbital.local/secure/'))"
    message: "vault only runs images from registry.orbital.local/secure/ (the path CI signs)"
---
apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingAdmissionPolicyBinding
metadata:
  name: vault-trusted-images
spec:
  policyName: vault-trusted-images
  validationActions: ["Deny"]
  matchResources:
    namespaceSelector:
      matchLabels:
        team: vault
`;
const vaultSts = (c: ObjectiveContext): StatefulSet | undefined => c.view.get<StatefulSet>('StatefulSet', 'vault', 'ledger');

export const m5_7: Mission = {
  id: '5.7', chapter: 5, order: 7, title: 'Capstone: The vault', tagline: 'A replicated datastore that is durable, locked down and least-privileged.',
  ticket: {
    from: 'Chief Helmsman Okafor', priority: 'P1', subject: 'Stand up the replicated ledger in the vault namespace — to the letter of the security baseline',
    body: [
      'The vault namespace already enforces the Restricted Pod Security Standard. Deploy the 3-member ledger there from ~/manifests/ledger.yaml. As written it will not start: fix it, do not weaken the namespace.',
      'Requirements: each member has its own 2Gi disk at /var/lib/ledger; Pods run as ServiceAccount `ledger`, which may only get/list/watch/create/update ConfigMaps in vault (leader election); the image is private — pull credentials are user `vault-pull`, password `t0k3n-9f2c`, registry `registry.orbital.local`; and the image policy in ~/policies/trusted-registry.yaml must be active.',
      'Acceptance test: all three members Ready, then delete `ledger-0` and show it recovers its entries.',
    ],
  },
  concepts: [
    { title: 'Read the controller\'s events', body: 'When a StatefulSet shows 0 Pods, the reason is in its events: `kubectl describe sts ledger -n vault`. `FailedCreate` carries the admission error verbatim — a missing ServiceAccount, a Pod Security violation — one at a time, in the order the API server checks them.', example: 'kubectl describe sts ledger -n vault\nkubectl get events -n vault --sort-by=.lastTimestamp' },
    { title: 'Private registries', body: 'A registry that needs credentials wants a Secret of type `kubernetes.io/dockerconfigjson`, referenced by the Pod (`imagePullSecrets`) or — better — by its ServiceAccount, so every Pod using that account can pull.', example: 'kubectl create secret docker-registry regcred --docker-server=… --docker-username=… --docker-password=… -n vault\nkubectl patch serviceaccount ledger -n vault -p \'{"imagePullSecrets":[{"name":"regcred"}]}\'' },
    { title: 'In the real world: signed images', body: 'CI signs what it builds (cosign) and publishes an SBOM; an admission controller (Kyverno, Sigstore policy-controller) verifies the signature before a Pod is admitted. Here the policy pins the registry path only CI can push to — the structural half of the same idea.', example: 'kubectl apply -f policies/trusted-registry.yaml' },
  ],
  cluster: {
    seed: 67, nodes: orbitalNodes(), images: ORBITAL_IMAGES,
    objects: [ns('vault', { team: 'vault', 'pod-security.kubernetes.io/enforce': 'restricted' }), ...systemWorkloads(), storageClass('ceph-block', { isDefault: true })],
  },
  files: { 'manifests/ledger.yaml': VAULT_LEDGER, 'policies/trusted-registry.yaml': TRUSTED },
  objectives: [
    { id: 'identity', text: 'ServiceAccount ledger may manage ConfigMaps in vault — and cannot read Secrets', check: (c) => !!c.view.get('ServiceAccount', 'vault', 'ledger') && ['get', 'update'].every((v) => can(c, 'vault', 'ledger', v, 'configmaps', 'vault')) && !can(c, 'vault', 'ledger', 'get', 'secrets', 'vault') && !can(c, 'vault', 'ledger', 'get', 'configmaps', 'kube-system') },
    { id: 'pull', text: 'Pull credentials exist and the ledger Pods use them', check: (c) => { const names = [...((c.view.get('ServiceAccount', 'vault', 'ledger')?.imagePullSecrets as { name: string }[] | undefined) ?? []), ...(vaultSts(c)?.spec.template.spec.imagePullSecrets ?? [])].map((x) => x.name); return names.some((n) => c.view.get<Secret>('Secret', 'vault', n)?.type === 'kubernetes.io/dockerconfigjson'); } },
    { id: 'hardened', text: 'The StatefulSet template meets the Restricted standard', check: (c) => restricted(vaultSts(c)?.spec.template.spec) },
    { id: 'storage', text: 'Each member has its own 2Gi claim mounted at /var/lib/ledger', check: (c) => { const s = vaultSts(c); const t = s?.spec.volumeClaimTemplates?.[0]; return !!t && !!s?.spec.template.spec.containers[0]?.volumeMounts?.some((m) => m.name === t.metadata.name && m.mountPath.replace(/\/$/, '') === '/var/lib/ledger') && [0, 1, 2].every((i) => c.view.get<PersistentVolumeClaim>('PersistentVolumeClaim', 'vault', `${t.metadata.name}-ledger-${i}`)?.status?.phase === 'Bound'); } },
    { id: 'ready', text: 'ledger is 3/3 ready', check: (c) => vaultSts(c)?.status.readyReplicas === 3 },
    { id: 'policy', text: 'The image policy is active: a workload from another registry is denied in vault', check: (c) => denied(c, { ...probe('vault', 'redis:7', 1) }) && !denied(c, probe('vault', 'registry.orbital.local/secure/ledger:2.0', 1)) },
    { id: 'durable', text: 'Delete ledger-0 and show that it recovered its entries', revealAfter: 'ready', check: (c) => c.history.some((h) => /^(kubectl|k) delete (pods?|po)[ /]ledger-0\b/.test(h.line)) && c.history.some((h) => /^(kubectl|k) logs\b.*ledger-0/.test(h.line) && /recovered [1-9]\d* entries/.test(h.stdout)) && vaultSts(c)?.status.readyReplicas === 3 },
  ],
  hints: [
    { text: 'Apply the manifest and read `kubectl describe sts ledger -n vault`: the first FailedCreate is about the ServiceAccount. `kubectl create serviceaccount ledger -n vault`, a Role on configmaps (`--verb=get,list,watch,create,update`), a RoleBinding. The next error is Pod Security: add the full restricted `securityContext` to the container.', cost: 150 },
    { text: 'Storage: add `volumeMounts: [{name: data, mountPath: /var/lib/ledger}]` and, at StatefulSet spec level, `volumeClaimTemplates` with `metadata.name: data`, `accessModes: ["ReadWriteOnce"]`, `resources.requests.storage: 2Gi`. `volumeClaimTemplates` cannot be changed on an existing StatefulSet: `kubectl delete sts ledger -n vault`, then apply. Pull: `kubectl create secret docker-registry regcred … -n vault` and patch it into the ServiceAccount\'s `imagePullSecrets`.', cost: 150 },
    { text: 'A pod stuck in ImagePullBackOff or with wrong template needs replacing after the fix: `kubectl delete pod ledger-0 -n vault`. Then `kubectl apply -f policies/trusted-registry.yaml`, wait for 3/3, `kubectl delete pod ledger-0 -n vault`, `kubectl logs ledger-0 -n vault`.', cost: 150 },
  ],
  par: { timeSec: 840, commands: 18 }, timeLimitSec: 1500,
  solution: [
    'kubectl apply -f manifests/ledger.yaml',
    'sleep 2',
    'kubectl describe sts ledger -n vault',
    'kubectl create serviceaccount ledger -n vault',
    'kubectl create role ledger-election --verb=get,list,watch,create,update --resource=configmaps -n vault',
    'kubectl create rolebinding ledger-election --role=ledger-election --serviceaccount=vault:ledger -n vault',
    'kubectl create secret docker-registry regcred --docker-server=registry.orbital.local --docker-username=vault-pull --docker-password=t0k3n-9f2c -n vault',
    'kubectl patch serviceaccount ledger -n vault -p \'{"imagePullSecrets":[{"name":"regcred"}]}\'',
    { edit: 'manifests/ledger.yaml', replace: ['        readinessProbe:\n          httpGet:\n            path: /readyz\n            port: 8080\n          periodSeconds: 5\n', '        readinessProbe:\n          httpGet:\n            path: /readyz\n            port: 8080\n          periodSeconds: 5\n        securityContext:\n          runAsNonRoot: true\n          allowPrivilegeEscalation: false\n          capabilities:\n            drop: ["ALL"]\n          seccompProfile:\n            type: RuntimeDefault\n        volumeMounts:\n        - name: data\n          mountPath: /var/lib/ledger\n  volumeClaimTemplates:\n  - metadata:\n      name: data\n    spec:\n      accessModes: ["ReadWriteOnce"]\n      resources:\n        requests:\n          storage: 2Gi\n'] },
    'kubectl apply -f manifests/ledger.yaml',
    'kubectl delete statefulset ledger -n vault',
    'kubectl apply -f manifests/ledger.yaml',
    'kubectl apply -f policies/trusted-registry.yaml',
    'kubectl rollout status statefulset/ledger -n vault',
    'kubectl get pods,pvc -n vault',
    'sleep 6',
    'kubectl delete pod ledger-0 -n vault',
    'sleep 14',
    'kubectl logs ledger-0 -n vault',
  ],
  debrief: { proTips: ['You fixed four independent layers — identity, admission, storage, supply chain. In an incident, the controller\'s events tell you which layer said no; learn to read them before the YAML.', 'Backups are the fifth layer: volume snapshots plus object backups (Velero), restored regularly to prove they work.', 'An operator would own this datastore\'s failover and upgrades. What you built by hand is what it automates.'] },
};

export const chapter5: Mission[] = [m5_1, m5_2, m5_3, m5_4, m5_5, m5_6, m5_7];
