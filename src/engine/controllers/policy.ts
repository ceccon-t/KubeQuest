/**
 * Small policy controllers: namespace bootstrap (default ServiceAccount, kube-root-ca.crt), PodDisruptionBudget
 * status + the eviction API, and ResourceQuota status. upstream: pkg/controller/{serviceaccount,disruption,resourcequota}
 */
import type { Engine } from '../engine.ts';
import type { Pod, PodDisruptionBudget, ResourceQuota, ReplicaSet, StatefulSet, Deployment, Condition } from '../types.ts';
import { fromLabelSelector, matches } from '../selector.ts';
import { isPodReady } from './kubelet.ts';
import { quotaUsage, formatQuotaValue } from '../admission.ts';
import { ApiError } from '../store.ts';

const ROOT_CA = '-----BEGIN CERTIFICATE-----\nMIIDBTCCAe2gAwIBAgIIJm0s8pM3hXIwDQYJKoZIhvcNAQELBQAwFTETMBEGA1UE\nAxMKa3ViZXJuZXRlczAeFw0yNjA5MjEwOTAwMDBaFw0zNjA5MTgwOTA1MDBaMBUx\n-----END CERTIFICATE-----\n';

export function runNamespaceController(engine: Engine): void {
  for (const ns of engine.store.list('Namespace')) {
    if (ns.metadata.deletionTimestamp) continue;
    const name = ns.metadata.name;
    if (!engine.store.get('ServiceAccount', name, 'default')) engine.store.create({ apiVersion: 'v1', kind: 'ServiceAccount', metadata: { name: 'default', namespace: name } });
    if (!engine.store.get('ConfigMap', name, 'kube-root-ca.crt')) engine.store.create({ apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'kube-root-ca.crt', namespace: name, annotations: { 'kubernetes.io/description': "Contains a CA bundle that can be used to verify the kube-apiserver when using internal endpoints such as the internal service IP or kubernetes.default.svc. No other usage is guaranteed across distributions of Kubernetes clusters." } }, data: { 'ca.crt': ROOT_CA } });
  }
}

function scaled(v: number | string, total: number, roundUp: boolean): number {
  if (typeof v === 'number') return v;
  const m = /^(\d+)%$/.exec(v);
  if (!m) return parseInt(v, 10) || 0;
  const x = (parseInt(m[1] as string, 10) * total) / 100;
  return roundUp ? Math.ceil(x) : Math.floor(x);
}

function pdbPods(engine: Engine, pdb: PodDisruptionBudget): Pod[] {
  if (!pdb.spec.selector) return [];
  const reqs = fromLabelSelector(pdb.spec.selector);
  return engine.store.list<Pod>('Pod', pdb.metadata.namespace).filter((p) => matches(reqs, p.metadata.labels) && p.status.phase !== 'Succeeded' && p.status.phase !== 'Failed');
}

/** Expected pod count: the scale of the owning controllers (upstream getExpectedScale), falling back to the pods seen. */
function expectedCount(engine: Engine, pods: Pod[]): number {
  const seen = new Set<string>();
  let total = 0, orphans = 0;
  for (const p of pods) {
    let owner = engine.store.controllerOf(p);
    if (owner?.kind === 'ReplicaSet') owner = engine.store.controllerOf(owner) ?? owner;
    if (!owner) { orphans++; continue; }
    if (seen.has(owner.metadata.uid as string)) continue;
    seen.add(owner.metadata.uid as string);
    total += (owner as ReplicaSet | StatefulSet | Deployment).spec.replicas ?? 1;
  }
  return total + orphans;
}

function computePdb(engine: Engine, pdb: PodDisruptionBudget): PodDisruptionBudget['status'] {
  const pods = pdbPods(engine, pdb);
  const live = pods.filter((p) => !p.metadata.deletionTimestamp);
  const expected = pdb.spec.maxUnavailable !== undefined || typeof pdb.spec.minAvailable === 'string' ? expectedCount(engine, pods) : live.length;
  const healthy = live.filter(isPodReady).length;
  const desired = pdb.spec.maxUnavailable !== undefined ? Math.max(0, expected - scaled(pdb.spec.maxUnavailable, expected, true)) : scaled(pdb.spec.minAvailable ?? 0, expected, true);
  const allowed = Math.max(0, healthy - desired);
  const prev = pdb.status?.conditions?.[0];
  const cond: Condition = { type: 'DisruptionAllowed', status: allowed > 0 ? 'True' : 'False', reason: allowed > 0 ? 'SufficientPods' : 'InsufficientPods', message: '', lastTransitionTime: prev && prev.status === (allowed > 0 ? 'True' : 'False') ? prev.lastTransitionTime : engine.clock.iso() };
  return { conditions: [cond], currentHealthy: healthy, desiredHealthy: desired, disruptionsAllowed: allowed, expectedPods: expected, observedGeneration: pdb.metadata.generation };
}

export function runPolicyControllers(engine: Engine): void {
  runNamespaceController(engine);
  for (const pdb of engine.store.list<PodDisruptionBudget>('PodDisruptionBudget')) {
    const status = computePdb(engine, pdb);
    if (JSON.stringify(status) !== JSON.stringify(pdb.status)) { pdb.status = status; engine.store.update(pdb); }
  }
  for (const q of engine.store.list<ResourceQuota>('ResourceQuota')) {
    const usage = quotaUsage(engine, q.metadata.namespace as string);
    const hard: Record<string, string> = {}, used: Record<string, string> = {};
    for (const [k, v] of Object.entries(q.spec.hard ?? {})) { hard[k] = String(v); used[k] = formatQuotaValue(k, usage[k] ?? 0); }
    const status = { hard, used };
    if (JSON.stringify(status) !== JSON.stringify(q.status)) { q.status = status; engine.store.update(q); }
  }
}

/** The eviction subresource: delete the pod unless a PodDisruptionBudget forbids it (HTTP 429). */
export function evictPod(engine: Engine, pod: Pod, graceSeconds?: number): void {
  const budgets = engine.store.list<PodDisruptionBudget>('PodDisruptionBudget', pod.metadata.namespace).filter((b) => b.spec.selector && matches(fromLabelSelector(b.spec.selector), pod.metadata.labels));
  if (budgets.length > 1) throw new ApiError('BadRequest', 'This pod has more than one PodDisruptionBudget, which the eviction subresource does not support.');
  const pdb = budgets[0];
  if (pdb && pod.status.phase !== 'Pending') {
    const status = computePdb(engine, pdb);
    // an unhealthy pod may always go when the budget is otherwise met (unhealthyPodEvictionPolicy: IfHealthyBudget)
    const blocked = isPodReady(pod) ? status.disruptionsAllowed <= 0 : status.currentHealthy < status.desiredHealthy;
    if (blocked) throw new ApiError('Forbidden', "Cannot evict pod as it would violate the pod's disruption budget.");
  }
  engine.store.markDeleting(pod, graceSeconds ?? pod.spec.terminationGracePeriodSeconds ?? 30);
}
