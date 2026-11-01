/** ReplicaSet controller: keep spec.replicas pods matching the selector. upstream: pkg/controller/replicaset */
import type { Engine } from '../engine.ts';
import type { Pod, ReplicaSet, Condition } from '../types.ts';
import { fromLabelSelector, matches } from '../selector.ts';
import { applyDefaults } from '../defaults.ts';
import { isPodReady, isPodAvailable } from './kubelet.ts';

const BURST = 500;

export function activePods(engine: Engine, rs: ReplicaSet): Pod[] {
  const reqs = fromLabelSelector(rs.spec.selector);
  const out: Pod[] = [];
  for (const p of engine.store.list<Pod>('Pod', rs.metadata.namespace)) {
    if (p.metadata.deletionTimestamp) continue;
    if (p.status.phase === 'Succeeded' || p.status.phase === 'Failed') continue;
    const ctrl = p.metadata.ownerReferences?.find((r) => r.controller);
    if (ctrl) {
      if (ctrl.uid !== rs.metadata.uid) continue;
    } else {
      // adopt orphans with matching labels (upstream ClaimPods)
      if (!matches(reqs, p.metadata.labels)) continue;
      p.metadata.ownerReferences = [...(p.metadata.ownerReferences ?? []), engine.store.ownerRef(rs)];
      engine.store.update(p);
    }
    if (!matches(reqs, p.metadata.labels)) {
      // controller releases pods whose labels no longer match (upstream: release orphaned pod)
      p.metadata.ownerReferences = p.metadata.ownerReferences?.filter((r) => r.uid !== rs.metadata.uid);
      engine.store.update(p);
      continue;
    }
    out.push(p);
  }
  return out;
}

/** Deletion priority (upstream ActivePods sort): unscheduled < pending < unknown < running, not-ready < ready, newer < older. */
function phaseRank(p: Pod): number {
  switch (p.status.phase) {
    case 'Pending': return 0;
    case 'Unknown': return 1;
    default: return 2;
  }
}
export function rankForDeletion(a: Pod, b: Pod): number {
  const as = a.spec.nodeName ? 1 : 0, bs = b.spec.nodeName ? 1 : 0;
  if (as !== bs) return as - bs;
  const ap = phaseRank(a), bp = phaseRank(b);
  if (ap !== bp) return ap - bp;
  const ar = isPodReady(a) ? 1 : 0, br = isPodReady(b) ? 1 : 0;
  if (ar !== br) return ar - br;
  const arc = (a.status.containerStatuses ?? []).reduce((n, c) => n + c.restartCount, 0);
  const brc = (b.status.containerStatuses ?? []).reduce((n, c) => n + c.restartCount, 0);
  if (arc !== brc) return brc - arc; // more restarts deleted first
  const at = Date.parse(a.metadata.creationTimestamp ?? ''), bt = Date.parse(b.metadata.creationTimestamp ?? '');
  return bt - at; // newer first
}

export function newPodFromTemplate(engine: Engine, rs: ReplicaSet): Pod {
  const tpl = rs.spec.template;
  const pod: Pod = {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name: `${rs.metadata.name}-${engine.rng.suffix()}`,
      namespace: rs.metadata.namespace,
      generateName: `${rs.metadata.name}-`,
      labels: { ...(tpl.metadata.labels ?? {}) },
      ...(tpl.metadata.annotations ? { annotations: { ...tpl.metadata.annotations } } : {}),
      ownerReferences: [engine.store.ownerRef(rs)],
    },
    spec: structuredClone(tpl.spec),
    status: { phase: 'Pending' },
  };
  return applyDefaults(pod, engine);
}

export function runReplicaSetController(engine: Engine): void {
  const now = engine.clock.nowMs;
  for (const rs of engine.store.list<ReplicaSet>('ReplicaSet')) {
    if (rs.metadata.deletionTimestamp) continue;
    const pods = activePods(engine, rs);
    const desired = rs.spec.replicas ?? 1;
    const diff = pods.length - desired;
    if (diff < 0) {
      const n = Math.min(-diff, BURST);
      for (let i = 0; i < n; i++) {
        const pod = newPodFromTemplate(engine, rs);
        try {
          engine.store.create(pod);
          engine.store.event({ type: 'Normal', reason: 'SuccessfulCreate', message: `Created pod: ${pod.metadata.name}`, involved: rs, component: 'replicaset-controller' });
          pods.push(pod);
        } catch (e) {
          engine.store.event({ type: 'Warning', reason: 'FailedCreate', message: `Error creating: ${(e as Error).message}`, involved: rs, component: 'replicaset-controller' });
        }
      }
    } else if (diff > 0) {
      const victims = [...pods].sort(rankForDeletion).slice(0, Math.min(diff, BURST));
      for (const v of victims) {
        engine.store.markDeleting(v, v.spec.terminationGracePeriodSeconds ?? 30);
        engine.store.event({ type: 'Normal', reason: 'SuccessfulDelete', message: `Deleted pod: ${v.metadata.name}`, involved: rs, component: 'replicaset-controller' });
      }
    }
    // status
    const live = activePods(engine, rs);
    const reqs = fromLabelSelector(rs.spec.selector);
    const fully = live.filter((p) => Object.entries(rs.spec.template.metadata.labels ?? {}).every(([k, v]) => p.metadata.labels?.[k] === v)).length;
    const ready = live.filter(isPodReady).length;
    const available = live.filter((p) => isPodAvailable(p, rs.spec.minReadySeconds ?? 0, now)).length;
    void reqs;
    const status: ReplicaSet['status'] = {
      replicas: live.length,
      fullyLabeledReplicas: fully,
      readyReplicas: ready,
      availableReplicas: available,
      observedGeneration: rs.metadata.generation,
    };
    const conds: Condition[] = [];
    if (status.replicas === 0) delete status.fullyLabeledReplicas;
    if (ready === 0) delete status.readyReplicas;
    if (available === 0) delete status.availableReplicas;
    if (conds.length) status.conditions = conds;
    if (JSON.stringify(status) !== JSON.stringify(rs.status)) {
      rs.status = status;
      engine.store.update(rs);
    }
  }
}
