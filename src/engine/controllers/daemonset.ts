/** DaemonSet controller: one pod per eligible node; RollingUpdate on template change. */
import type { Engine } from '../engine.ts';
import type { DaemonSet, Pod, Node } from '../types.ts';
import { applyDefaults } from '../defaults.ts';
import { isPodReady, isPodAvailable } from './kubelet.ts';
import { tolerates } from './scheduler.ts';
import { sortKeys } from '../yaml.ts';

const DS_TOLERATIONS = [
  { key: 'node.kubernetes.io/not-ready', operator: 'Exists', effect: 'NoExecute' },
  { key: 'node.kubernetes.io/unreachable', operator: 'Exists', effect: 'NoExecute' },
  { key: 'node.kubernetes.io/disk-pressure', operator: 'Exists', effect: 'NoSchedule' },
  { key: 'node.kubernetes.io/memory-pressure', operator: 'Exists', effect: 'NoSchedule' },
  { key: 'node.kubernetes.io/pid-pressure', operator: 'Exists', effect: 'NoSchedule' },
  { key: 'node.kubernetes.io/unschedulable', operator: 'Exists', effect: 'NoSchedule' },
] as const;

function hashOf(engine: Engine, ds: DaemonSet): string {
  return engine.rng.hash(JSON.stringify(sortKeys(ds.spec.template)));
}

function eligible(ds: DaemonSet, node: Node): boolean {
  const sel = ds.spec.template.spec.nodeSelector ?? {};
  if (!Object.entries(sel).every(([k, v]) => node.metadata.labels?.[k] === v)) return false;
  const tol = [...(ds.spec.template.spec.tolerations ?? []), ...DS_TOLERATIONS.map((t) => ({ ...t }))];
  for (const t of node.spec.taints ?? []) if (t.effect !== 'PreferNoSchedule' && !tolerates(tol, t)) return false;
  return true;
}

export function runDaemonSetController(engine: Engine): void {
  const nodes = engine.store.list<Node>('Node');
  for (const ds of engine.store.list<DaemonSet>('DaemonSet')) {
    if (ds.metadata.deletionTimestamp) continue;
    const hash = hashOf(engine, ds);
    const pods = engine.store.ownedBy<Pod>(ds, 'Pod').filter((p) => !p.metadata.deletionTimestamp);
    const byNode = new Map<string, Pod[]>();
    for (const p of pods) {
      const n = p.spec.nodeName ?? p.spec.affinity ? (p.spec.nodeName ?? '') : '';
      byNode.set(n, [...(byNode.get(n) ?? []), p]);
    }
    let desired = 0, current = 0, ready = 0, available = 0, updated = 0, misscheduled = 0;
    const maxUnavailable = Math.max(1, typeof ds.spec.updateStrategy?.rollingUpdate?.maxUnavailable === 'number' ? ds.spec.updateStrategy.rollingUpdate.maxUnavailable : 1);
    let unavailableBudget = maxUnavailable;
    for (const node of nodes) {
      const onNode = byNode.get(node.metadata.name) ?? [];
      const ok = eligible(ds, node);
      if (ok) desired++;
      if (!ok) {
        for (const p of onNode) { misscheduled++; engine.store.markDeleting(p, p.spec.terminationGracePeriodSeconds ?? 30); }
        continue;
      }
      if (onNode.length === 0) {
        const pod = newDsPod(engine, ds, node, hash);
        engine.store.create(pod);
        engine.store.event({ type: 'Normal', reason: 'SuccessfulCreate', message: `Created pod: ${pod.metadata.name}`, involved: ds, component: 'daemonset-controller' });
        continue;
      }
      // keep one pod per node (delete extras)
      for (const p of onNode.slice(1)) engine.store.markDeleting(p, p.spec.terminationGracePeriodSeconds ?? 30);
      const p = onNode[0]!;
      current++;
      const isReady = isPodReady(p);
      if (isReady) ready++;
      if (isPodAvailable(p, ds.spec.minReadySeconds ?? 0, engine.clock.nowMs)) available++;
      if (p.metadata.labels?.['controller-revision-hash'] === hash) updated++;
      else if ((ds.spec.updateStrategy?.type ?? 'RollingUpdate') === 'RollingUpdate' && unavailableBudget > 0) {
        unavailableBudget--;
        engine.store.markDeleting(p, p.spec.terminationGracePeriodSeconds ?? 30);
        engine.store.event({ type: 'Normal', reason: 'SuccessfulDelete', message: `Deleted pod: ${p.metadata.name}`, involved: ds, component: 'daemonset-controller' });
      }
      if (!isReady) unavailableBudget--;
    }
    const status: DaemonSet['status'] = { currentNumberScheduled: current, desiredNumberScheduled: desired, numberMisscheduled: misscheduled, numberReady: ready, numberAvailable: available, numberUnavailable: desired - available, updatedNumberScheduled: updated, observedGeneration: ds.metadata.generation };
    if (status.numberAvailable === 0) delete status.numberAvailable;
    if (status.numberUnavailable === 0) delete status.numberUnavailable;
    if (status.updatedNumberScheduled === 0) delete status.updatedNumberScheduled;
    if (JSON.stringify(status) !== JSON.stringify(ds.status)) { ds.status = status; engine.store.update(ds); }
  }
}

function newDsPod(engine: Engine, ds: DaemonSet, node: Node, hash: string): Pod {
  const tpl = ds.spec.template;
  const spec = structuredClone(tpl.spec);
  spec.affinity = { nodeAffinity: { requiredDuringSchedulingIgnoredDuringExecution: { nodeSelectorTerms: [{ matchFields: [{ key: 'metadata.name', operator: 'In', values: [node.metadata.name] }] }] } } };
  spec.tolerations = [...(spec.tolerations ?? []), ...DS_TOLERATIONS.map((t) => ({ ...t }))];
  const pod: Pod = {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name: `${ds.metadata.name}-${engine.rng.suffix()}`,
      namespace: ds.metadata.namespace,
      generateName: `${ds.metadata.name}-`,
      labels: { ...(tpl.metadata.labels ?? {}), 'controller-revision-hash': hash, 'pod-template-generation': String(ds.metadata.generation ?? 1) },
      ownerReferences: [engine.store.ownerRef(ds)],
    },
    spec,
    status: { phase: 'Pending' },
  };
  return applyDefaults(pod, engine);
}
