/**
 * Scenario tests for the simulator features behind chapters 4b–8: API machinery (RBAC, admission, CRDs),
 * storage and StatefulSets, scheduling, autoscaling and disruption, network policy, delivery tooling and events.
 * Expected strings follow kubectl / Kubernetes v1.32, kustomize v5.5, Helm v3.17, git 2.43 and Argo CD v3.0.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine, type ClusterSetup } from '../../src/engine/engine.ts';
import { makeShell, runLine } from '../../src/engine/testing.ts';
import { generatorHash, kustomizeBuild } from '../../src/engine/kustomize.ts';
import { Vfs } from '../../src/engine/vfs.ts';
import { stringify, type YamlValue } from '../../src/engine/yaml.ts';
import { crd, S, storageClass, argoCd, ARGO_IMAGES } from '../../src/missions/platform.ts';
import type { Deployment, Event, KubeObject, Pod, PersistentVolumeClaim } from '../../src/engine/types.ts';

const NODES = [{ name: 'cp-1', roles: ['control-plane'] }, { name: 'worker-a', labels: { 'topology.kubernetes.io/zone': 'a' } }, { name: 'worker-b', labels: { 'topology.kubernetes.io/zone': 'b' } }];

function cluster(files: Record<string, string> = {}, extra: Partial<ClusterSetup> = {}) {
  const engine = new Engine({ seed: 11, nodes: NODES, clusterAgeSeconds: 3 * 86400, ...extra });
  const { shell, host } = makeShell(engine, files);
  const run = (line: string) => runLine(shell, host, line);
  return { engine, shell, host, run };
}

const deploy = (name: string, opts: { replicas?: number; image?: string; extra?: string; ns?: string } = {}): string => `apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${name}${opts.ns ? `\n  namespace: ${opts.ns}` : ''}
spec:
  replicas: ${opts.replicas ?? 2}
  selector:
    matchLabels:
      app: ${name}
  template:
    metadata:
      labels:
        app: ${name}
    spec:
      containers:
      - name: ${name}
        image: ${opts.image ?? 'nginx:1.27'}
${opts.extra ?? ''}`;

// --- RBAC ------------------------------------------------------------------------

test('RBAC: impersonation is authorized like the subject, with the upstream Forbidden text', async () => {
  const { run } = cluster();
  await run('kubectl create namespace team');
  assert.equal((await run('kubectl auth can-i list pods -n team --as=system:serviceaccount:team:default')).stdout, 'no\n');
  const denied = await run('kubectl get pods -n team --as=system:serviceaccount:team:default');
  assert.equal(denied.stderr, 'Error from server (Forbidden): pods is forbidden: User "system:serviceaccount:team:default" cannot list resource "pods" in API group "" in the namespace "team"\n');
  await run('kubectl create role pod-reader --verb=get,list,watch --resource=pods -n team');
  await run('kubectl create rolebinding read --role=pod-reader --serviceaccount=team:default -n team');
  assert.equal((await run('kubectl auth can-i list pods -n team --as=system:serviceaccount:team:default')).stdout, 'yes\n');
  assert.equal((await run('kubectl auth can-i delete pods -n team --as=system:serviceaccount:team:default')).stdout, 'no\n');
  assert.equal((await run('kubectl auth can-i list pods -n default --as=system:serviceaccount:team:default')).stdout, 'no\n');
  // a RoleBinding to a ClusterRole grants it in that namespace only
  await run('kubectl create rolebinding devs --clusterrole=edit --group=devs -n team');
  assert.equal((await run('kubectl auth can-i create deployments -n team --as=jo --as-group=devs')).stdout, 'yes\n');
  assert.equal((await run('kubectl auth can-i create deployments -n default --as=jo --as-group=devs')).stdout, 'no\n');
});

// --- admission -------------------------------------------------------------------

test('ResourceQuota rejects Pods at admission; LimitRange defaults make them admissible', async () => {
  const { run, engine } = cluster({ 'web.yaml': deploy('web', { ns: 'team' }), 'lr.yaml': 'apiVersion: v1\nkind: LimitRange\nmetadata:\n  name: defaults\n  namespace: team\nspec:\n  limits:\n  - type: Container\n    defaultRequest:\n      cpu: 100m\n      memory: 64Mi\n    default:\n      cpu: 200m\n      memory: 128Mi\n' });
  await run('kubectl create namespace team');
  await run('kubectl create quota q -n team --hard=requests.cpu=1,requests.memory=1Gi,limits.cpu=2,limits.memory=2Gi,pods=5');
  await run('kubectl apply -f web.yaml');
  engine.advance(3);
  assert.equal((await run('kubectl get pods -n team')).stderr, 'No resources found in team namespace.\n');
  const rs = await run('kubectl describe rs -n team');
  assert.match(rs.stdout, /Warning {2}FailedCreate .* replicaset-controller {2}Error creating: pods "web-[a-z0-9]+-[a-z0-9]+" is forbidden: failed quota: q: must specify limits\.cpu for: web; limits\.memory for: web; requests\.cpu for: web; requests\.memory for: web/);
  const direct = await run('kubectl run big -n team --image=nginx:1.27 --requests=cpu=2,memory=64Mi --limits=cpu=2,memory=64Mi');
  assert.equal(direct.stderr, 'Error from server (Forbidden): pods "big" is forbidden: exceeded quota: q, requested: requests.cpu=2, used: requests.cpu=0, limited: requests.cpu=1\n');
  assert.equal((await run('kubectl apply -f lr.yaml')).stdout, 'limitrange/defaults created\n');
  await run('kubectl rollout restart deployment/web -n team');
  engine.advance(15);
  const pods = engine.store.list<Pod>('Pod', 'team');
  assert.equal(pods.length, 2);
  assert.deepEqual(pods[0]?.spec.containers[0]?.resources, { limits: { cpu: '200m', memory: '128Mi' }, requests: { cpu: '100m', memory: '64Mi' } });
  assert.match((await run('kubectl describe quota q -n team')).stdout, /requests\.cpu +200m +1\n/);
});

test('Pod Security Admission: enforce rejects, a server dry run of the label previews', async () => {
  const { run, engine } = cluster({ 'web.yaml': deploy('web', { ns: 'team' }) });
  await run('kubectl create namespace team');
  await run('kubectl apply -f web.yaml');
  engine.advance(5);
  const preview = await run('kubectl label --dry-run=server --overwrite ns team pod-security.kubernetes.io/enforce=restricted');
  assert.match(preview.stderr, /^Warning: existing pods in namespace "team" violate the new PodSecurity enforce level "restricted:latest"\nWarning: web-[a-z0-9]+-[a-z0-9]+ \(and 1 other pod\): allowPrivilegeEscalation != false, unrestricted capabilities, runAsNonRoot != true, seccompProfile\n$/);
  assert.equal(preview.stdout, 'namespace/team labeled (server dry run)\n');
  assert.equal(engine.store.get('Namespace', undefined, 'team')?.metadata.labels?.['pod-security.kubernetes.io/enforce'], undefined);
  await run('kubectl label ns team pod-security.kubernetes.io/enforce=restricted');
  const rejected = await run('kubectl run intruder --image=nginx:1.27 -n team');
  assert.equal(rejected.stderr, 'Error from server (Forbidden): pods "intruder" is forbidden: violates PodSecurity "restricted:latest": allowPrivilegeEscalation != false (container "intruder" must set securityContext.allowPrivilegeEscalation=false), unrestricted capabilities (container "intruder" must set securityContext.capabilities.drop=["ALL"]), runAsNonRoot != true (pod or container "intruder" must set securityContext.runAsNonRoot=true), seccompProfile (pod or container "intruder" must set securityContext.seccompProfile.type to "RuntimeDefault" or "Localhost")\n');
});

const VAP = `apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingAdmissionPolicy
metadata:
  name: max-replicas
spec:
  failurePolicy: Fail
  matchConstraints:
    resourceRules:
    - apiGroups: ["apps"]
      apiVersions: ["v1"]
      operations: ["CREATE", "UPDATE"]
      resources: ["deployments"]
  validations:
  - expression: "object.spec.replicas <= 5"
    message: "at most 5 replicas"
---
apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingAdmissionPolicyBinding
metadata:
  name: max-replicas
spec:
  policyName: max-replicas
  validationActions: ["Deny"]
`;

test('ValidatingAdmissionPolicy: CEL denies creates and updates, Warn only warns', async () => {
  const { run, shell } = cluster({ 'vap.yaml': VAP, 'web.yaml': deploy('web') });
  await run('kubectl apply -f vap.yaml');
  await run('kubectl apply -f web.yaml');
  const denied = await run('kubectl scale deployment web --replicas=9');
  assert.equal(denied.stderr, 'The deployments "web" is invalid: : ValidatingAdmissionPolicy \'max-replicas\' with binding \'max-replicas\' denied request: at most 5 replicas\n');
  assert.equal((await run('kubectl scale deployment web --replicas=5')).code, 0);
  shell.vfs.write('/home/oncall/vap.yaml', VAP.replace('["Deny"]', '["Warn"]'));
  await run('kubectl apply -f vap.yaml');
  const warned = await run('kubectl scale deployment web --replicas=9');
  assert.equal(warned.code, 0);
  assert.equal(warned.stderr, 'Warning: Validation failed for ValidatingAdmissionPolicy \'max-replicas\' with binding \'max-replicas\': at most 5 replicas\n');
});

// --- CRDs ------------------------------------------------------------------------

test('CustomResourceDefinition: new kind is served, validated against its schema, and removed with the CRD', async () => {
  const CRD = stringify(crd({ group: 'orbital.local', kind: 'RouteCache', plural: 'routecaches', shortNames: ['rcache'], version: 'v1', spec: S.obj({ replicas: S.int({ minimum: 1, maximum: 5 }), tier: S.str({ enum: ['small', 'large'] }) }, ['replicas']), columns: [{ name: 'Replicas', type: 'integer', jsonPath: '.spec.replicas' }] }) as unknown as YamlValue);
  const CR = 'apiVersion: orbital.local/v1\nkind: RouteCache\nmetadata:\n  name: main\nspec:\n  replicas: 3\n  tier: small\n';
  const { run, shell } = cluster({ 'crd.yaml': CRD, 'cr.yaml': CR });
  const before = await run('kubectl apply -f cr.yaml');
  assert.equal(before.stderr, 'error: resource mapping not found for name: "main" namespace: "" from "cr.yaml": no matches for kind "RouteCache" in version "orbital.local/v1"\nensure CRDs are installed first\n');
  await run('kubectl apply -f crd.yaml');
  assert.equal((await run('kubectl api-resources --api-group=orbital.local')).stdout, 'NAME          SHORTNAMES   APIVERSION         NAMESPACED   KIND\nroutecaches   rcache       orbital.local/v1   true         RouteCache\n');
  shell.vfs.write('/home/oncall/bad.yaml', CR.replace('tier: small', 'tier: medium').replace('replicas: 3', 'replicas: 9'));
  const bad = await run('kubectl apply -f bad.yaml');
  assert.equal(bad.stderr, 'The RouteCache "main" is invalid: \n* spec.replicas: Invalid value: 9: spec.replicas in body should be less than or equal to 5\n* spec.tier: Unsupported value: "medium": supported values: "small", "large"\n');
  assert.equal((await run('kubectl apply -f cr.yaml')).stdout, 'routecache.orbital.local/main created\n');
  // with additionalPrinterColumns the server prints NAME plus exactly those columns (no implicit AGE)
  assert.equal((await run('kubectl get rcache')).stdout, 'NAME   REPLICAS\nmain   3\n');
  await run('kubectl delete crd routecaches.orbital.local');
  assert.match((await run('kubectl get routecaches')).stderr, /^error: the server doesn't have a resource type "routecaches"\n$/);
});

// --- storage and StatefulSets ----------------------------------------------------

const STS = `apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: db
spec:
  serviceName: db
  replicas: 2
  selector:
    matchLabels:
      app: db
  template:
    metadata:
      labels:
        app: db
    spec:
      containers:
      - name: redis
        image: redis:7
        volumeMounts:
        - name: data
          mountPath: /data
  volumeClaimTemplates:
  - metadata:
      name: data
    spec:
      accessModes: ["ReadWriteOnce"]
      resources:
        requests:
          storage: 1Gi
`;

test('PVC: unknown class stays Pending with the upstream event; the default class provisions', async () => {
  const pvc = (cls: string) => `apiVersion: v1\nkind: PersistentVolumeClaim\nmetadata:\n  name: data\nspec:\n  accessModes: ["ReadWriteOnce"]\n${cls}  resources:\n    requests:\n      storage: 5Gi\n`;
  const { run, engine } = cluster({ 'bad.yaml': pvc('  storageClassName: fast-ssd\n'), 'good.yaml': pvc(''), 'other.yaml': pvc('  storageClassName: ceph-block\n') }, { objects: [storageClass('ceph-block', { isDefault: true })] });
  await run('kubectl apply -f bad.yaml');
  engine.advance(3);
  assert.match((await run('kubectl describe pvc data')).stdout, /Warning {2}ProvisioningFailed .* persistentvolume-controller {2}storageclass\.storage\.k8s\.io "fast-ssd" not found/);
  for (const file of ['other.yaml', 'good.yaml']) {
    const immutable = await run(`kubectl apply -f ${file}`);
    assert.equal(immutable.stderr, 'The PersistentVolumeClaim "data" is invalid: spec: Forbidden: spec is immutable after creation except resources.requests and volumeAttributesClassName for bound claims\n', file);
  }
  await run('kubectl delete pvc data');
  await run('kubectl apply -f good.yaml');
  engine.advance(3);
  const claim = engine.store.get<PersistentVolumeClaim>('PersistentVolumeClaim', 'default', 'data');
  assert.equal(claim?.status?.phase, 'Bound');
  assert.equal(claim?.spec.storageClassName, 'ceph-block');
  assert.match((await run('kubectl get pv')).stdout, /pvc-[0-9a-f-]{36} {3}5Gi {8}RWO {12}Delete {11}Bound {4}default\/data {3}ceph-block/);
});

test('StatefulSet: ordered pods, one claim per ordinal, stable identity, per-pod DNS through a headless Service', async () => {
  const { run, engine } = cluster({ 'sts.yaml': STS }, { objects: [storageClass('ceph-block', { isDefault: true })] });
  await run('kubectl apply -f sts.yaml');
  engine.advance(1);
  assert.deepEqual(engine.store.list<Pod>('Pod', 'default').map((p) => p.metadata.name), ['db-0'], 'db-1 waits for db-0 to be Ready');
  engine.advance(20);
  assert.match((await run('kubectl get pods,pvc')).stdout, /pod\/db-0 {3}1\/1 {5}Running[\s\S]*pod\/db-1 {3}1\/1 {5}Running[\s\S]*persistentvolumeclaim\/data-db-0 {3}Bound[\s\S]*persistentvolumeclaim\/data-db-1 {3}Bound/);
  await run('kubectl run tools --image=busybox:1.36 -- sleep 3600');
  engine.advance(5);
  assert.match((await run('kubectl exec tools -- nslookup db-0.db')).output, /can't resolve|NXDOMAIN/);
  await run('kubectl create service clusterip db --clusterip=None --tcp=6379:6379');
  engine.advance(2);
  assert.match((await run('kubectl exec tools -- nslookup db-0.db')).stdout, /Name:\s+db-0\.db\.default\.svc\.cluster\.local\nAddress: 10\.244\./);
  const uid = engine.store.get<Pod>('Pod', 'default', 'db-1')?.metadata.uid;
  await run('kubectl delete pod db-1');
  engine.advance(15);
  const again = engine.store.get<Pod>('Pod', 'default', 'db-1');
  assert.notEqual(again?.metadata.uid, uid);
  assert.equal(again?.spec.volumes?.[0]?.persistentVolumeClaim?.claimName, 'data-db-1');
  const frozen = await run('kubectl patch sts db --type merge -p \'{"spec":{"serviceName":"other"}}\'');
  assert.match(frozen.stderr, /spec: Forbidden: updates to statefulset spec for fields other than 'replicas', 'ordinals', 'template', 'updateStrategy', 'persistentVolumeClaimRetentionPolicy' and 'minReadySeconds' are forbidden/);
});

// --- scheduling ------------------------------------------------------------------

test('Scheduler: taints, extended resources and topology spread with matchLabelKeys', async () => {
  const gpu = { name: 'gpu-1', labels: { 'topology.kubernetes.io/zone': 'b' }, taints: [{ key: 'nvidia.com/gpu', value: 'present', effect: 'NoSchedule' as const }], extendedResources: { 'nvidia.com/gpu': '1' } };
  const pod = (tol: string) => `apiVersion: v1\nkind: Pod\nmetadata:\n  name: train\nspec:\n${tol}  containers:\n  - name: c\n    image: nginx:1.27\n    resources:\n      limits:\n        nvidia.com/gpu: 1\n`;
  const spread = deploy('web', { replicas: 2, extra: '      topologySpreadConstraints:\n      - maxSkew: 1\n        topologyKey: topology.kubernetes.io/zone\n        whenUnsatisfiable: DoNotSchedule\n        labelSelector:\n          matchLabels:\n            app: web\n        matchLabelKeys:\n        - pod-template-hash\n' });
  const { run, engine } = cluster({ 'train.yaml': pod(''), 'ok.yaml': pod('  tolerations:\n  - key: nvidia.com/gpu\n    operator: Exists\n    effect: NoSchedule\n'), 'web.yaml': spread }, { nodes: [...NODES, gpu] });
  await run('kubectl apply -f train.yaml');
  engine.advance(2);
  assert.match((await run('kubectl describe pod train')).stdout, /0\/4 nodes are available: 1 node\(s\) had untolerated taint \{node-role\.kubernetes\.io\/control-plane: \}, 1 node\(s\) had untolerated taint \{nvidia\.com\/gpu: present\}, 2 Insufficient nvidia\.com\/gpu\. preemption: 0\/4 nodes are available: 2 No preemption victims found for incoming pod, 2 Preemption is not helpful for scheduling\./);
  // a Pod that was never bound has nothing to wait for: it is gone at once
  await run('kubectl delete pod train --wait=false');
  assert.equal(engine.store.get('Pod', 'default', 'train'), undefined);
  await run('kubectl apply -f ok.yaml');
  engine.advance(5);
  assert.equal(engine.store.get<Pod>('Pod', 'default', 'train')?.spec.nodeName, 'gpu-1');
  assert.match((await run('kubectl describe node gpu-1')).stdout, / {2}nvidia\.com\/gpu {5}1 {9}1\n/);
  // rolling update: with matchLabelKeys only the new revision is counted, so it ends up one per zone again
  await run('kubectl apply -f web.yaml');
  engine.advance(10);
  await run('kubectl set env deployment/web ROLL=1');
  engine.advance(40);
  const zones = engine.store.list<Pod>('Pod', 'default').filter((p) => p.metadata.labels?.app === 'web').map((p) => engine.store.get('Node', undefined, p.spec.nodeName ?? '')?.metadata.labels?.['topology.kubernetes.io/zone']).sort();
  assert.deepEqual(zones, ['a', 'b']);
});

// --- autoscaling and disruption --------------------------------------------------

test('HPA: <unknown> without a CPU request, then scales on utilization', async () => {
  const images = { 'web:1': { ports: [8080], cpuMillis: 20, cpuPerRequestMillis: 20, capacityRps: 20, http: { '/': { status: 200, body: 'ok\n' } } } };
  const { run, engine } = cluster({ 'web.yaml': deploy('web', { image: 'web:1' }) }, { images });
  await run('kubectl apply -f web.yaml');
  await run('kubectl expose deployment web --port=80 --target-port=8080');
  await run('kubectl autoscale deployment web --min=2 --max=6 --cpu-percent=50');
  engine.advance(20);
  assert.match((await run('kubectl get hpa')).stdout, /\nweb +Deployment\/web +cpu: <unknown>\/50% +2 +6 +2 +\d+s\n$/);
  assert.match((await run('kubectl describe hpa web')).stdout, /ScalingActive {2}False {3}FailedGetResourceMetric {2}the HPA was unable to compute the replica count: failed to get cpu utilization: missing request for cpu in container web of Pod web-/);
  await run('kubectl set resources deployment web --requests=cpu=100m');
  engine.advance(30);
  engine.traffic.addSource({ id: 'load', service: 'default/web', rps: 30, label: 'load' });
  engine.advance(90);
  const d = engine.store.get<Deployment>('Deployment', 'default', 'web');
  assert.ok((d?.spec.replicas ?? 0) >= 4, `expected a scale-up, got ${d?.spec.replicas}`);
  assert.match((await run('kubectl get events')).stdout, /SuccessfulRescale .* New size: \d; reason: cpu resource utilization \(percentage of request\) above target/);
});

test('PDB: drain evicts through the budget and reports the upstream retry line', async () => {
  const { run, engine, host } = cluster({ 'web.yaml': deploy('web', { replicas: 1, extra: '      nodeSelector:\n        kubernetes.io/hostname: worker-a\n' }) });
  await run('kubectl apply -f web.yaml');
  await run('kubectl create pdb web --selector=app=web --min-available=1');
  engine.advance(5);
  assert.match((await run('kubectl get pdb')).stdout, /^NAME +MIN AVAILABLE +MAX UNAVAILABLE +ALLOWED DISRUPTIONS +AGE\nweb +1 +N\/A +0 +\d+s\n$/);
  host.maxWaitMs = 12_000;
  const stuck = await run('kubectl drain worker-a --ignore-daemonsets --timeout=11s');
  assert.match(stuck.stderr, /error when evicting pods\/"web-[a-z0-9-]+" -n "default" \(will retry after 5s\): Cannot evict pod as it would violate the pod's disruption budget\.\n/);
  assert.equal(engine.store.list<Pod>('Pod', 'default').length, 1, 'the pod is still there');
  host.abortFlag = false; host.waited = 0; host.maxWaitMs = 60_000;
  await run('kubectl delete pdb web');
  const ok = await run('kubectl drain worker-a --ignore-daemonsets');
  assert.match(ok.stdout, /node\/worker-a already cordoned\n[\s\S]*pod\/web-[a-z0-9-]+ evicted\nnode\/worker-a drained\n$/);
});

// --- network policy --------------------------------------------------------------

test('NetworkPolicy: default deny drops (timeout), same-namespace allow lets peers in', async () => {
  const { run, engine } = cluster({ 'netpol.yaml': 'apiVersion: networking.k8s.io/v1\nkind: NetworkPolicy\nmetadata:\n  name: default-deny\n  namespace: a\nspec:\n  podSelector: {}\n  policyTypes: [Ingress]\n---\napiVersion: networking.k8s.io/v1\nkind: NetworkPolicy\nmetadata:\n  name: same-ns\n  namespace: a\nspec:\n  podSelector: {}\n  policyTypes: [Ingress]\n  ingress:\n  - from:\n    - podSelector: {}\n' });
  await run('kubectl create namespace a');
  await run('kubectl create namespace b');
  await run('kubectl run web -n a --image=nginx:1.27 --port=80 --labels=app=web');
  await run('kubectl expose pod web -n a --port=80');
  await run('kubectl run peer -n a --image=busybox:1.36 -- sleep 3600');
  await run('kubectl run outsider -n b --image=busybox:1.36 -- sleep 3600');
  engine.advance(8);
  assert.equal((await run('kubectl exec outsider -n b -- wget -qO- -T 2 web.a')).code, 0);
  await run('kubectl apply -f netpol.yaml');
  const heredoc = await run('kubectl apply -f - <<EOF');
  assert.match(heredoc.stderr, /^kubequest: here-documents \(<<EOF\) are not supported in this terminal/);
  const blocked = await run('kubectl exec outsider -n b -- wget -qO- -T 2 web.a');
  assert.match(blocked.output, /wget: download timed out/);
  assert.notEqual(blocked.code, 0);
  assert.equal((await run('kubectl exec peer -n a -- wget -qO- -T 2 web')).code, 0);
});

// --- kustomize / helm / gitops ---------------------------------------------------

test('Kustomize: name-suffix hashes match upstream vectors; overlays transform and merge generators', () => {
  // upstream: api/hasher/hasher_test.go
  assert.equal(generatorHash({ apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: '' } } as KubeObject), '6ct58987ht');
  assert.equal(generatorHash({ apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: '' }, data: { one: '' } } as KubeObject), '9g67k2htb6');
  assert.equal(generatorHash({ apiVersion: 'v1', kind: 'Secret', metadata: { name: '' }, type: 'my-type' } as KubeObject), '5gmgkf8578');
  const vfs = new Vfs({
    '/w/base/kustomization.yaml': 'resources:\n- deploy.yaml\nconfigMapGenerator:\n- name: web-config\n  literals:\n  - LOG_LEVEL=info\n  - REGION=luna\n',
    '/w/base/deploy.yaml': deploy('web', { replicas: 1, extra: '        envFrom:\n        - configMapRef:\n            name: web-config\n' }),
    '/w/prod/kustomization.yaml': 'namespace: prod\nresources:\n- ../base\nlabels:\n- pairs:\n    env: prod\nimages:\n- name: nginx\n  newTag: "1.28"\nreplicas:\n- name: web\n  count: 3\nconfigMapGenerator:\n- name: web-config\n  behavior: merge\n  literals:\n  - LOG_LEVEL=warn\n',
  });
  const { objects } = kustomizeBuild(vfs, '/w/prod');
  const cm = objects.find((o) => o.kind === 'ConfigMap') as KubeObject & { data: Record<string, string> };
  const d = objects.find((o) => o.kind === 'Deployment') as Deployment;
  assert.deepEqual(cm.data, { LOG_LEVEL: 'warn', REGION: 'luna' });
  assert.match(cm.metadata.name, /^web-config-[a-z0-9]{10}$/);
  assert.equal(d.spec.template.spec.containers[0]?.envFrom?.[0]?.configMapRef?.name, cm.metadata.name, 'references follow the generated name');
  assert.equal(d.metadata.namespace, 'prod');
  assert.equal(d.metadata.labels?.env, 'prod');
  assert.equal(d.spec.replicas, 3);
  assert.equal(d.spec.template.spec.containers[0]?.image, 'nginx:1.28');
  assert.equal(d.spec.selector.matchLabels?.env, undefined, 'labels do not touch selectors unless asked to');
});

const CHART = {
  'chart/Chart.yaml': 'apiVersion: v2\nname: web\nversion: 0.1.0\nappVersion: "1.27"\n',
  'chart/values.yaml': 'replicaCount: 1\nimage:\n  repository: nginx\n  tag: ""\n',
  'chart/templates/deployment.yaml': 'apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: {{ .Release.Name }}\nspec:\n  replicas: {{ .Values.replicaCount }}\n  selector:\n    matchLabels:\n      app: {{ .Release.Name }}\n  template:\n    metadata:\n      labels:\n        app: {{ .Release.Name }}\n    spec:\n      containers:\n      - name: web\n        image: "{{ .Values.image.repository }}:{{ .Values.image.tag | default .Chart.AppVersion }}"\n',
  'prod.yaml': 'replicaCount: 3\n',
};

test('Helm: revisions, values that do not carry over, rollback', async () => {
  const { run, engine } = cluster(CHART);
  const install = await run('helm install web chart -f prod.yaml');
  assert.match(install.stdout, /^NAME: web\nLAST DEPLOYED: .*\nNAMESPACE: default\nSTATUS: deployed\nREVISION: 1\nTEST SUITE: None\n$/);
  assert.equal(engine.store.get<Deployment>('Deployment', 'default', 'web')?.spec.replicas, 3);
  assert.equal(engine.store.get('Secret', 'default', 'sh.helm.release.v1.web.v1')?.type, 'helm.sh/release.v1');
  // an upgrade without the values file falls back to the chart default
  await run('helm upgrade web chart --set image.tag=1.28');
  const d = engine.store.get<Deployment>('Deployment', 'default', 'web');
  assert.equal(d?.spec.replicas, 1);
  assert.equal(d?.spec.template.spec.containers[0]?.image, 'nginx:1.28');
  assert.equal((await run('helm rollback web 1')).stdout, 'Rollback was a success! Happy Helming!\n');
  assert.equal(engine.store.get<Deployment>('Deployment', 'default', 'web')?.spec.replicas, 3);
  const history = (await run('helm history web')).stdout.split('\n');
  assert.match(history[0] ?? '', /^REVISION\tUPDATED\s+\tSTATUS\s+\tCHART\s+\tAPP VERSION\tDESCRIPTION\s*$/);
  assert.match(history[1] ?? '', /^1 .*superseded\tweb-0\.1\.0\t1\.27 +\tInstall complete/);
  assert.match(history[3] ?? '', /^3 .*deployed {2}\tweb-0\.1\.0\t1\.27 +\tRollback to 1/);
  assert.equal((await run('helm get values web')).stdout, 'USER-SUPPLIED VALUES:\nreplicaCount: 3\n');
});

test('GitOps: an Argo CD Application syncs commits, self-heals drift and prunes', async () => {
  const URL = 'https://git.example/deploy.git';
  const app = { apiVersion: 'argoproj.io/v1alpha1', kind: 'Application', metadata: { name: 'web', namespace: 'argocd' }, spec: { project: 'default', source: { repoURL: URL, path: 'app', targetRevision: 'HEAD' }, destination: { server: 'https://kubernetes.default.svc', namespace: 'default' }, syncPolicy: { automated: { prune: true, selfHeal: true } } } };
  const files = { 'deploy/app/web.yaml': deploy('web'), 'deploy/app/cm.yaml': 'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: banner\ndata:\n  text: hi\n' };
  const { run, engine, shell } = cluster(files, { images: ARGO_IMAGES, objects: [...argoCd(), { ageSeconds: 60, object: app }], gitRemotes: { [URL]: 'deploy' }, gitPollSeconds: 20 });
  engine.advance(15);
  assert.match((await run('kubectl get applications -n argocd')).stdout, /^NAME {3}SYNC STATUS {3}HEALTH STATUS\nweb {4}Synced {8}Healthy\n$/);
  // drift is reverted
  await run('kubectl scale deployment web --replicas=5');
  engine.advance(8);
  assert.equal(engine.store.get<Deployment>('Deployment', 'default', 'web')?.spec.replicas, 2);
  // a commit is rolled out; a removed file is pruned
  shell.vfs.write('/home/oncall/deploy/app/web.yaml', deploy('web', { replicas: 3 }));
  await run('cd deploy');
  await run('rm app/cm.yaml');
  assert.match((await run('git status')).stdout, /modified: {3}app\/web\.yaml[\s\S]*deleted: {4}app\/cm\.yaml|deleted: {4}app\/cm\.yaml[\s\S]*modified: {3}app\/web\.yaml/);
  await run('git add -A');
  assert.match((await run('git commit -m "three replicas, no banner"')).stdout, /^\[main [0-9a-f]{7}\] three replicas, no banner\n 2 files changed, 1 insertion\(\+\), 7 deletions\(-\)\n delete mode 100644 app\/cm\.yaml\n$/);
  assert.match((await run('git push')).output, /^To https:\/\/git\.example\/deploy\.git\n {3}[0-9a-f]{7}\.\.[0-9a-f]{7} {2}main -> main\n$/);
  engine.advance(40);
  assert.equal(engine.store.get<Deployment>('Deployment', 'default', 'web')?.spec.replicas, 3);
  assert.equal(engine.store.get('ConfigMap', 'default', 'banner'), undefined);
});

// --- controllers and events ------------------------------------------------------

test('Events: similar events are combined after ten, and expire an hour after their last update', async () => {
  const { run, engine } = cluster({ 'web.yaml': deploy('web', { ns: 'team' }) });
  await run('kubectl create namespace team');
  await run('kubectl create quota q -n team --hard=requests.cpu=1');
  await run('kubectl apply -f web.yaml');
  engine.advance(600);
  const events = engine.store.list<Event>('Event', 'team').filter((e) => e.reason === 'FailedCreate');
  assert.equal(events.length, 10, 'nine distinct messages, then one combined event');
  const combined = events.filter((e) => e.message.startsWith('(combined from similar events): Error creating: pods "web-'));
  assert.equal(combined.length, 1);
  assert.ok((combined[0]?.count ?? 0) > 1);
  // the nine single events are not refreshed, so they age out; the combined one keeps being updated
  engine.advance(2 * 3600, 30_000);
  // upstream: once retries are further apart than the aggregator's 10-minute window (the back-off tops out at 1000s),
  // each failure is a separate event again; only the last hour's are kept
  const later = engine.store.list<Event>('Event', 'team').filter((e) => e.reason === 'FailedCreate');
  assert.ok(later.length >= 1 && later.length <= 5, `got ${later.length}`);
  for (const e of later) assert.ok(engine.clock.nowMs - Date.parse(e.lastTimestamp ?? '') <= 3_600_000 + 60_000);
});

test('Controllers: a refused create backs off, but a change to the object is synced at once', async () => {
  const { run, engine } = cluster({ 'web.yaml': deploy('web', { ns: 'team', replicas: 1 }) });
  await run('kubectl create namespace team');
  await run('kubectl create quota q -n team --hard=pods=0');
  await run('kubectl apply -f web.yaml');
  engine.advance(900);
  await run('kubectl delete quota q -n team');
  engine.advance(20);
  assert.equal(engine.store.list<Pod>('Pod', 'team').length, 0, 'still waiting out its back-off: nothing told the ReplicaSet controller');
  await run('kubectl scale deployment web --replicas=2 -n team');
  engine.advance(2);
  assert.equal(engine.store.list<Pod>('Pod', 'team').length, 2, 'an update to the ReplicaSet is enqueued immediately');
});

test('Deployment: a rollout that timed out progresses again when a new ReplicaSet is created', async () => {
  const { run, engine } = cluster({ 'web.yaml': deploy('web', { image: 'nginx:9.9.9' }) });
  await run('kubectl apply -f web.yaml');
  engine.advance(700, 1000);
  assert.equal((await run('kubectl rollout status deployment/web')).stderr, 'error: deployment "web" exceeded its progress deadline\n');
  await run('kubectl set image deployment/web web=nginx:1.27');
  const status = await run('kubectl rollout status deployment/web');
  assert.match(status.stdout, /deployment "web" successfully rolled out\n$/);
});

test('Job: the pod template is immutable, and may omit metadata', async () => {
  const job = (image: string) => `apiVersion: batch/v1\nkind: Job\nmetadata:\n  name: once\nspec:\n  template:\n    spec:\n      restartPolicy: Never\n      containers:\n      - name: c\n        image: ${image}\n        command: ["sh", "-c", "echo done"]\n`;
  const { run, engine, shell } = cluster({ 'job.yaml': job('busybox:1.36') });
  assert.equal((await run('kubectl apply -f job.yaml')).stdout, 'job.batch/once created\n');
  engine.advance(10);
  assert.equal((await run('kubectl apply -f job.yaml')).stdout, 'job.batch/once unchanged\n');
  shell.vfs.write('/home/oncall/job.yaml', job('busybox:1.37'));
  assert.equal((await run('kubectl apply -f job.yaml')).stderr, 'The Job "once" is invalid: spec.template: Invalid value: core.PodTemplateSpec{…}: field is immutable\n');
});
