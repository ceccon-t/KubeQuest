/**
 * Deployment controller. Follows pkg/controller/deployment: pod-template-hash ReplicaSets,
 * RollingUpdate (maxSurge / maxUnavailable), Recreate, revisions, rollback, progress deadline.
 */
import type { Engine } from '../engine.ts';
import type { Deployment, ReplicaSet, Pod, Condition, PodTemplateSpec } from '../types.ts';
import { activePods } from './replicaset.ts';
import { isPodAvailable, isPodReady } from './kubelet.ts';
import { applyDefaults } from '../defaults.ts';
import { sortKeys } from '../yaml.ts';

export const REVISION_ANNOTATION = 'deployment.kubernetes.io/revision';
export const REVISION_HISTORY_ANNOTATION = 'deployment.kubernetes.io/revision-history';
export const DESIRED_REPLICAS_ANNOTATION = 'deployment.kubernetes.io/desired-replicas';
export const MAX_REPLICAS_ANNOTATION = 'deployment.kubernetes.io/max-replicas';
export const CHANGE_CAUSE_ANNOTATION = 'kubernetes.io/change-cause';

export function templateHash(engine: Engine, tpl: PodTemplateSpec): string {
  const t = structuredClone(tpl);
  delete t.metadata.labels?.['pod-template-hash'];
  return engine.rng.hash(JSON.stringify(sortKeys(t)));
}

function templateEquals(a: PodTemplateSpec, b: PodTemplateSpec): boolean {
  const ca = structuredClone(a), cb = structuredClone(b);
  delete ca.metadata.labels?.['pod-template-hash'];
  delete cb.metadata.labels?.['pod-template-hash'];
  return JSON.stringify(sortKeys(ca)) === JSON.stringify(sortKeys(cb));
}

export function replicaSetsOf(engine: Engine, d: Deployment): ReplicaSet[] {
  return engine.store.ownedBy<ReplicaSet>(d, 'ReplicaSet').filter((rs) => !rs.metadata.deletionTimestamp);
}

export function findNewReplicaSet(engine: Engine, d: Deployment): ReplicaSet | undefined {
  const rss = replicaSetsOf(engine, d).sort((a, b) => (a.metadata.creationTimestamp! < b.metadata.creationTimestamp! ? -1 : 1));
  return rss.find((rs) => templateEquals(rs.spec.template, d.spec.template));
}

export function revisionOf(rs: ReplicaSet): number {
  return parseInt(rs.metadata.annotations?.[REVISION_ANNOTATION] ?? '0', 10);
}

function resolveFenceposts(d: Deployment): { maxSurge: number; maxUnavailable: number } {
  const replicas = d.spec.replicas ?? 1;
  const ru = d.spec.strategy?.rollingUpdate ?? {};
  const pct = (v: number | string | undefined, def: string, roundUp: boolean): number => {
    const s = String(v ?? def);
    if (s.endsWith('%')) {
      const f = (parseInt(s, 10) / 100) * replicas;
      return roundUp ? Math.ceil(f) : Math.floor(f);
    }
    return parseInt(s, 10);
  };
  let maxSurge = pct(ru.maxSurge, '25%', true);
  let maxUnavailable = pct(ru.maxUnavailable, '25%', false);
  if (maxSurge === 0 && maxUnavailable === 0) maxUnavailable = 1; // upstream: at least one must be non-zero
  maxSurge = Math.max(0, maxSurge);
  return { maxSurge, maxUnavailable: Math.min(Math.max(0, maxUnavailable), replicas) };
}

function rsReplicas(rss: ReplicaSet[]): number {
  return rss.reduce((n, rs) => n + (rs.spec.replicas ?? 0), 0);
}

function createNewReplicaSet(engine: Engine, d: Deployment, oldRss: ReplicaSet[]): ReplicaSet {
  const hash = templateHash(engine, d.spec.template);
  const tpl = structuredClone(d.spec.template);
  tpl.metadata.labels = { ...(tpl.metadata.labels ?? {}), 'pod-template-hash': hash };
  const maxOld = oldRss.reduce((m, rs) => Math.max(m, revisionOf(rs)), 0);
  const newRevision = maxOld + 1;
  const annotations: Record<string, string> = {
    [DESIRED_REPLICAS_ANNOTATION]: String(d.spec.replicas ?? 1),
    [MAX_REPLICAS_ANNOTATION]: String((d.spec.replicas ?? 1) + resolveFenceposts(d).maxSurge),
    [REVISION_ANNOTATION]: String(newRevision),
  };
  const cause = d.metadata.annotations?.[CHANGE_CAUSE_ANNOTATION];
  if (cause) annotations[CHANGE_CAUSE_ANNOTATION] = cause;
  const rs: ReplicaSet = {
    apiVersion: 'apps/v1',
    kind: 'ReplicaSet',
    metadata: {
      name: `${d.metadata.name}-${hash}`,
      namespace: d.metadata.namespace,
      labels: { ...tpl.metadata.labels },
      annotations,
      ownerReferences: [engine.store.ownerRef(d)],
    },
    spec: {
      replicas: 0,
      minReadySeconds: d.spec.minReadySeconds,
      selector: { matchLabels: { ...(d.spec.selector.matchLabels ?? {}), 'pod-template-hash': hash }, ...(d.spec.selector.matchExpressions ? { matchExpressions: d.spec.selector.matchExpressions } : {}) },
      template: tpl,
    },
    status: { replicas: 0 },
  };
  if (rs.spec.minReadySeconds === undefined) delete rs.spec.minReadySeconds;
  applyDefaults(rs, engine);
  rs.spec.replicas = 0;
  engine.store.create(rs);
  return rs;
}

function scaleRs(engine: Engine, d: Deployment, rs: ReplicaSet, n: number): void {
  const prev = rs.spec.replicas ?? 0;
  if (prev === n) return;
  rs.spec.replicas = n;
  rs.metadata.annotations = { ...(rs.metadata.annotations ?? {}), [DESIRED_REPLICAS_ANNOTATION]: String(d.spec.replicas ?? 1), [MAX_REPLICAS_ANNOTATION]: String((d.spec.replicas ?? 1) + resolveFenceposts(d).maxSurge) };
  engine.store.update(rs, { specChanged: true });
  engine.store.event({ type: 'Normal', reason: 'ScalingReplicaSet', message: `Scaled ${n > prev ? 'up' : 'down'} replica set ${rs.metadata.name} from ${prev} to ${n}`, involved: d, component: 'deployment-controller' });
}

function availableOf(engine: Engine, rs: ReplicaSet, minReady: number): { pods: Pod[]; ready: number; available: number } {
  const pods = activePods(engine, rs);
  return { pods, ready: pods.filter(isPodReady).length, available: pods.filter((p) => isPodAvailable(p, minReady, engine.clock.nowMs)).length };
}

export function runDeploymentController(engine: Engine): void {
  for (const d of engine.store.list<Deployment>('Deployment')) {
    if (d.metadata.deletionTimestamp) continue;
    const rss = replicaSetsOf(engine, d);
    let newRs = findNewReplicaSet(engine, d);
    if (!newRs && !d.spec.paused) newRs = createNewReplicaSet(engine, d, rss);
    const oldRss = rss.filter((rs) => rs !== newRs);
    // keep revision annotation current if the template was rolled back to an older RS
    if (newRs) {
      const maxRev = rss.reduce((m, rs) => Math.max(m, revisionOf(rs)), 0);
      if (revisionOf(newRs) < maxRev) {
        const prev = revisionOf(newRs);
        newRs.metadata.annotations = { ...(newRs.metadata.annotations ?? {}), [REVISION_ANNOTATION]: String(maxRev + 1) };
        const hist = newRs.metadata.annotations[REVISION_HISTORY_ANNOTATION];
        newRs.metadata.annotations[REVISION_HISTORY_ANNOTATION] = hist ? `${hist},${prev}` : String(prev);
        engine.store.update(newRs);
      }
      const dRev = d.metadata.annotations?.[REVISION_ANNOTATION];
      if (dRev !== String(revisionOf(newRs))) {
        d.metadata.annotations = { ...(d.metadata.annotations ?? {}), [REVISION_ANNOTATION]: String(revisionOf(newRs)) };
        engine.store.update(d);
      }
    }
    if (!d.spec.paused && newRs) {
      if ((d.spec.strategy?.type ?? 'RollingUpdate') === 'Recreate') reconcileRecreate(engine, d, newRs, oldRss);
      else reconcileRolling(engine, d, newRs, oldRss);
      cleanupOld(engine, d, oldRss);
    }
    syncStatus(engine, d, newRs, rss);
  }
}

function reconcileRolling(engine: Engine, d: Deployment, newRs: ReplicaSet, oldRss: ReplicaSet[]): void {
  const replicas = d.spec.replicas ?? 1;
  const { maxSurge, maxUnavailable } = resolveFenceposts(d);
  const all = [newRs, ...oldRss];
  // --- scale up new RS (upstream reconcileNewReplicaSet / NewRSNewReplicas)
  const current = rsReplicas(all);
  if ((newRs.spec.replicas ?? 0) < replicas) {
    const maxTotal = replicas + maxSurge;
    if (current < maxTotal) {
      const scaleUp = Math.min(maxTotal - current, replicas - (newRs.spec.replicas ?? 0));
      scaleRs(engine, d, newRs, (newRs.spec.replicas ?? 0) + scaleUp);
    }
  } else if ((newRs.spec.replicas ?? 0) > replicas) {
    scaleRs(engine, d, newRs, replicas);
  }
  // --- scale down old RSs (upstream reconcileOldReplicaSets)
  const minReady = d.spec.minReadySeconds ?? 0;
  const oldPods = oldRss.reduce((n, rs) => n + (rs.spec.replicas ?? 0), 0);
  if (oldPods === 0) return;
  const allPodsCount = rsReplicas([newRs, ...oldRss]);
  const newAvail = availableOf(engine, newRs, minReady).available;
  const minAvailable = replicas - maxUnavailable;
  const newUnavailable = (newRs.spec.replicas ?? 0) - newAvail;
  let maxScaledDown = allPodsCount - minAvailable - newUnavailable;
  if (maxScaledDown <= 0) return;
  // 1. clean up unhealthy old replicas first
  const sortedOld = [...oldRss].sort((a, b) => (a.metadata.creationTimestamp! < b.metadata.creationTimestamp! ? -1 : 1));
  let totalScaledDown = 0;
  for (const rs of sortedOld) {
    if (totalScaledDown >= maxScaledDown) break;
    const r = rs.spec.replicas ?? 0;
    if (r === 0) continue;
    const { available } = availableOf(engine, rs, minReady);
    if (r === available) continue;
    const scaleDown = Math.min(r - available, maxScaledDown - totalScaledDown);
    scaleRs(engine, d, rs, r - scaleDown);
    totalScaledDown += scaleDown;
  }
  // 2. scale down healthy old replicas within the budget
  const availableNow = availableOf(engine, newRs, minReady).available + oldRss.reduce((n, rs) => n + availableOf(engine, rs, minReady).available, 0);
  let budget = availableNow - minAvailable;
  if (budget <= 0) return;
  for (const rs of sortedOld) {
    if (budget <= 0) break;
    const r = rs.spec.replicas ?? 0;
    if (r === 0) continue;
    const scaleDown = Math.min(r, budget);
    scaleRs(engine, d, rs, r - scaleDown);
    budget -= scaleDown;
  }
}

function reconcileRecreate(engine: Engine, d: Deployment, newRs: ReplicaSet, oldRss: ReplicaSet[]): void {
  const replicas = d.spec.replicas ?? 1;
  for (const rs of oldRss) if ((rs.spec.replicas ?? 0) > 0) scaleRs(engine, d, rs, 0);
  const oldPodsLeft = oldRss.some((rs) => activePods(engine, rs).length > 0) || engine.store.list<Pod>('Pod', d.metadata.namespace).some((p) => p.metadata.deletionTimestamp && oldRss.some((rs) => p.metadata.ownerReferences?.some((o) => o.uid === rs.metadata.uid)));
  if (oldPodsLeft) return;
  if ((newRs.spec.replicas ?? 0) !== replicas) scaleRs(engine, d, newRs, replicas);
}

function cleanupOld(engine: Engine, d: Deployment, oldRss: ReplicaSet[]): void {
  const limit = d.spec.revisionHistoryLimit ?? 10;
  const candidates = oldRss.filter((rs) => (rs.spec.replicas ?? 0) === 0 && rs.status.replicas === 0).sort((a, b) => revisionOf(a) - revisionOf(b));
  const toDelete = candidates.length - limit;
  for (let i = 0; i < toDelete; i++) engine.store.remove(candidates[i]!);
}

function syncStatus(engine: Engine, d: Deployment, newRs: ReplicaSet | undefined, rss: ReplicaSet[]): void {
  const minReady = d.spec.minReadySeconds ?? 0;
  let replicas = 0, ready = 0, available = 0;
  for (const rs of rss) {
    const a = availableOf(engine, rs, minReady);
    replicas += a.pods.length;
    ready += a.ready;
    available += a.available;
  }
  const updated = newRs ? availableOf(engine, newRs, minReady).pods.length : 0;
  const desired = d.spec.replicas ?? 1;
  const unavailable = Math.max(0, Math.max(desired, replicas) - available);
  const t = engine.clock.iso();
  const prev = d.status.conditions ?? [];
  const cond = (type: string, status: Condition['status'], reason: string, message: string): Condition => {
    const p = prev.find((c) => c.type === type);
    const same = p && p.status === status && p.reason === reason;
    return { type, status, lastUpdateTime: same && p.message === message ? p.lastUpdateTime : t, lastTransitionTime: p && p.status === status ? p.lastTransitionTime : t, reason, message };
  };
  const conds: Condition[] = [];
  const { maxUnavailable } = resolveFenceposts(d);
  const availOk = available >= desired - maxUnavailable && (desired === 0 || available > 0);
  conds.push(availOk ? cond('Available', 'True', 'MinimumReplicasAvailable', 'Deployment has minimum availability.') : cond('Available', 'False', 'MinimumReplicasUnavailable', 'Deployment does not have minimum availability.'));
  const complete = newRs && updated === desired && replicas === desired && available === desired && (d.status.observedGeneration === undefined || true);
  const prevProg = prev.find((c) => c.type === 'Progressing');
  if (d.spec.paused) conds.push(cond('Progressing', 'Unknown', 'DeploymentPaused', 'Deployment is paused'));
  else if (complete) conds.push(cond('Progressing', 'True', 'NewReplicaSetAvailable', `ReplicaSet "${newRs!.metadata.name}" has successfully progressed.`));
  else {
    const deadline = (d.spec.progressDeadlineSeconds ?? 600) * 1000;
    const since = prevProg && prevProg.reason !== 'NewReplicaSetAvailable' && prevProg.lastUpdateTime ? Date.parse(prevProg.lastUpdateTime) : engine.clock.nowMs;
    const stalled = prevProg?.reason === 'ProgressDeadlineExceeded' || engine.clock.nowMs - since > deadline;
    if (stalled) conds.push(cond('Progressing', 'False', 'ProgressDeadlineExceeded', `ReplicaSet "${newRs?.metadata.name ?? ''}" has timed out progressing.`));
    else {
      const progressing = { ...cond('Progressing', 'True', newRs && (newRs.spec.replicas ?? 0) > 0 ? 'ReplicaSetUpdated' : 'NewReplicaSetCreated', newRs ? `ReplicaSet "${newRs.metadata.name}" is progressing.` : 'Created new replica set') };
      // keep lastUpdateTime moving only when progress is made (upstream compares status); approximate with replica counts
      const key = `${replicas}/${updated}/${available}`;
      const prevKey = engine.scratch.get(`deploy-progress/${d.metadata.uid}`) as string | undefined;
      if (prevProg && prevProg.reason !== 'NewReplicaSetAvailable' && key === prevKey) progressing.lastUpdateTime = prevProg.lastUpdateTime;
      engine.scratch.set(`deploy-progress/${d.metadata.uid}`, key);
      conds.push(progressing);
    }
  }
  const status: Deployment['status'] = { observedGeneration: d.metadata.generation, conditions: conds };
  if (replicas) status.replicas = replicas;
  if (updated) status.updatedReplicas = updated;
  if (ready) status.readyReplicas = ready;
  if (available) status.availableReplicas = available;
  if (unavailable) status.unavailableReplicas = unavailable;
  if (JSON.stringify(status) !== JSON.stringify(d.status)) {
    d.status = status;
    engine.store.update(d);
  }
}

/** Set the deployment template from a ReplicaSet (rollback). */
export function rollbackTo(engine: Engine, d: Deployment, rs: ReplicaSet): void {
  const tpl = structuredClone(rs.spec.template);
  delete tpl.metadata.labels?.['pod-template-hash'];
  d.spec.template = tpl;
  engine.store.update(d, { specChanged: true });
  engine.store.event({ type: 'Normal', reason: 'DeploymentRollback', message: `Rolled back deployment "${d.metadata.name}" to revision ${revisionOf(rs)}`, involved: d, component: 'deployment-controller' });
}
