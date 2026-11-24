/** StatefulSet controller: stable identities, ordered rollout, per-pod claims. upstream: pkg/controller/statefulset */
import type { Engine } from '../engine.ts';
import { syncDue, syncFailed, syncSucceeded } from './requeue.ts';
import type { StatefulSet, Pod, PersistentVolumeClaim } from '../types.ts';
import { applyDefaults } from '../defaults.ts';
import { isPodReady, isPodAvailable } from './kubelet.ts';
import { sortKeys } from '../yaml.ts';
import { ApiError } from '../store.ts';
import { admitPod } from '../admission.ts';

export function statefulSetRevision(engine: Engine, sts: StatefulSet): string {
  return `${sts.metadata.name}-${engine.rng.hash(JSON.stringify(sortKeys(sts.spec.template)))}`;
}

function ordinalOf(sts: StatefulSet, pod: Pod): number {
  const m = new RegExp(`^${sts.metadata.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-(\\d+)$`).exec(pod.metadata.name);
  return m ? parseInt(m[1] as string, 10) : -1;
}

export function statefulSetPods(engine: Engine, sts: StatefulSet): Pod[] {
  return engine.store.ownedBy<Pod>(sts, 'Pod').filter((p) => ordinalOf(sts, p) >= 0).sort((a, b) => ordinalOf(sts, a) - ordinalOf(sts, b));
}

function claimName(sts: StatefulSet, tpl: PersistentVolumeClaim, ordinal: number): string {
  return `${tpl.metadata.name}-${sts.metadata.name}-${ordinal}`;
}

function newPod(engine: Engine, sts: StatefulSet, ordinal: number, revision: string): Pod {
  const tpl = sts.spec.template;
  const name = `${sts.metadata.name}-${ordinal}`;
  const spec = structuredClone(tpl.spec);
  spec.hostname = name;
  spec.subdomain = sts.spec.serviceName;
  const claims = (sts.spec.volumeClaimTemplates ?? []).map((t) => ({ name: t.metadata.name, persistentVolumeClaim: { claimName: claimName(sts, t, ordinal) } }));
  spec.volumes = [...claims, ...(spec.volumes ?? []).filter((v) => !claims.some((c) => c.name === v.name))];
  const pod: Pod = {
    apiVersion: 'v1', kind: 'Pod',
    metadata: {
      name, namespace: sts.metadata.namespace, generateName: `${sts.metadata.name}-`,
      labels: { ...(tpl.metadata.labels ?? {}), 'apps.kubernetes.io/pod-index': String(ordinal), 'controller-revision-hash': revision, 'statefulset.kubernetes.io/pod-name': name },
      ...(tpl.metadata.annotations ? { annotations: { ...tpl.metadata.annotations } } : {}),
      ownerReferences: [engine.store.ownerRef(sts)],
    },
    spec, status: { phase: 'Pending' },
  };
  return applyDefaults(pod, engine);
}

export function runStatefulSetController(engine: Engine): void {
  const now = engine.clock.nowMs;
  for (const sts of engine.store.list<StatefulSet>('StatefulSet')) {
    if (sts.metadata.deletionTimestamp) continue;
    const ev = (type: 'Normal' | 'Warning', reason: string, message: string) => engine.store.event({ type, reason, message, involved: sts, component: 'statefulset-controller' });
    const revision = statefulSetRevision(engine, sts);
    const desired = sts.spec.replicas ?? 1;
    const parallel = sts.spec.podManagementPolicy === 'Parallel';
    const pods = statefulSetPods(engine, sts);
    const byOrdinal = new Map<number, Pod>();
    for (const p of pods) byOrdinal.set(ordinalOf(sts, p), p);
    const healthy = (p: Pod | undefined): boolean => !!p && !p.metadata.deletionTimestamp && p.status.phase === 'Running' && isPodReady(p);
    // 1. create missing pods in ordinal order (OrderedReady waits for every predecessor to be Running and Ready)
    let blocked = false;
    // a refused create is retried with back-off (upstream requeues the set), not on every sync
    const retryKey = `sts:${sts.metadata.uid}`;
    for (let i = 0; i < desired && !(blocked && !parallel); i++) {
      const existing = byOrdinal.get(i);
      if (existing) { if (!healthy(existing)) blocked = true; continue; }
      if (!syncDue(engine, retryKey, sts)) { blocked = true; break; }
      for (const t of sts.spec.volumeClaimTemplates ?? []) {
        const cn = claimName(sts, t, i);
        if (engine.store.get('PersistentVolumeClaim', sts.metadata.namespace, cn)) continue;
        const pvc: PersistentVolumeClaim = { apiVersion: 'v1', kind: 'PersistentVolumeClaim', metadata: { name: cn, namespace: sts.metadata.namespace, labels: { ...(sts.spec.selector.matchLabels ?? {}) } }, spec: structuredClone(t.spec), status: { phase: 'Pending' } };
        engine.store.create(applyDefaults(pvc, engine));
        ev('Normal', 'SuccessfulCreate', `create Claim ${cn} Pod ${sts.metadata.name}-${i} in StatefulSet ${sts.metadata.name} success`);
      }
      const pod = newPod(engine, sts, i, revision);
      try {
        admitPod(engine, pod);
        engine.store.create(pod);
        ev('Normal', 'SuccessfulCreate', `create Pod ${pod.metadata.name} in StatefulSet ${sts.metadata.name} successful`);
        syncSucceeded(engine, retryKey);
      } catch (e) {
        if (!(e instanceof ApiError)) throw e;
        ev('Warning', 'FailedCreate', `create Pod ${pod.metadata.name} in StatefulSet ${sts.metadata.name} failed error: ${e.message}`);
        syncFailed(engine, retryKey, sts);
      }
      blocked = true;
    }
    // 2. scale down from the highest ordinal, one at a time
    const extra = pods.filter((p) => ordinalOf(sts, p) >= desired).reverse();
    if (extra.length && (parallel || !extra.some((p) => p.metadata.deletionTimestamp))) {
      for (const p of parallel ? extra : extra.slice(0, 1)) {
        if (p.metadata.deletionTimestamp) continue;
        engine.store.markDeleting(p, p.spec.terminationGracePeriodSeconds ?? 30);
        ev('Normal', 'SuccessfulDelete', `delete Pod ${p.metadata.name} in StatefulSet ${sts.metadata.name} successful`);
      }
    }
    // 3. rolling update: highest ordinal first, only while every other pod is healthy
    const strategy = sts.spec.updateStrategy?.type ?? 'RollingUpdate';
    const partition = sts.spec.updateStrategy?.rollingUpdate?.partition ?? 0;
    const inRange = pods.filter((p) => ordinalOf(sts, p) < desired);
    if (strategy === 'RollingUpdate' && !extra.length && inRange.length === desired && inRange.every(healthy)) {
      const stale = [...inRange].reverse().find((p) => ordinalOf(sts, p) >= partition && p.metadata.labels?.['controller-revision-hash'] !== revision);
      if (stale) {
        engine.store.markDeleting(stale, stale.spec.terminationGracePeriodSeconds ?? 30);
        ev('Normal', 'SuccessfulDelete', `delete Pod ${stale.metadata.name} in StatefulSet ${sts.metadata.name} successful`);
      }
    }
    // status
    const live = statefulSetPods(engine, sts).filter((p) => !p.metadata.deletionTimestamp);
    const updated = live.filter((p) => p.metadata.labels?.['controller-revision-hash'] === revision).length;
    const prev = sts.status ?? { replicas: 0 };
    const allUpdated = live.length === desired && updated === desired && live.every(healthy);
    const currentRevision = allUpdated || !prev.currentRevision ? revision : prev.currentRevision;
    const status: StatefulSet['status'] = {
      availableReplicas: live.filter((p) => isPodAvailable(p, sts.spec.minReadySeconds ?? 0, now)).length,
      collisionCount: 0,
      currentReplicas: live.filter((p) => p.metadata.labels?.['controller-revision-hash'] === currentRevision).length,
      currentRevision,
      observedGeneration: sts.metadata.generation,
      readyReplicas: live.filter(isPodReady).length,
      replicas: live.length,
      updateRevision: revision,
      updatedReplicas: updated,
    };
    if (JSON.stringify(status) !== JSON.stringify(sts.status)) { sts.status = status; engine.store.update(sts); }
  }
}
