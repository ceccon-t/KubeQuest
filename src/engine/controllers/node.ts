/** Node lifecycle controller: Ready conditions, NotReady taints, pod eviction after tolerationSeconds. */
import type { Engine } from '../engine.ts';
import type { Node, Pod, Condition } from '../types.ts';

const HEARTBEAT_MS = 10_000;

export function runNodeLifecycle(engine: Engine): void {
  const now = engine.clock.nowMs;
  for (const node of engine.store.list<Node>('Node')) {
    const rt = engine.nodeRuntime(node.metadata.name);
    const readyCond = node.status.conditions.find((c) => c.type === 'Ready');
    const wasReady = readyCond?.status === 'True';
    const heartbeatDue = now - rt.lastHeartbeat >= HEARTBEAT_MS;
    if (node.status.conditions.length === 0 || wasReady !== rt.ready || heartbeatDue) {
      rt.lastHeartbeat = now;
      const t = engine.clock.iso();
      const mk = (type: string, status: Condition['status'], reason: string, message: string): Condition => {
        const prev = node.status.conditions.find((c) => c.type === type);
        return { type, status, reason, message, lastHeartbeatTime: t, lastTransitionTime: prev && prev.status === status ? prev.lastTransitionTime : t } as Condition;
      };
      if (rt.ready) {
        node.status.conditions = [
          mk('MemoryPressure', 'False', 'KubeletHasSufficientMemory', 'kubelet has sufficient memory available'),
          mk('DiskPressure', 'False', 'KubeletHasNoDiskPressure', 'kubelet has no disk pressure'),
          mk('PIDPressure', 'False', 'KubeletHasSufficientPID', 'kubelet has sufficient PID available'),
          mk('Ready', 'True', 'KubeletReady', 'kubelet is posting ready status'),
        ];
        if (!wasReady && readyCond) {
          node.spec.taints = (node.spec.taints ?? []).filter((x) => x.key !== 'node.kubernetes.io/unreachable' && x.key !== 'node.kubernetes.io/not-ready');
          if (node.spec.taints.length === 0) delete node.spec.taints;
          engine.store.event({ type: 'Normal', reason: 'NodeReady', message: `Node ${node.metadata.name} status is now: NodeReady`, involved: node, component: 'kubelet', host: node.metadata.name });
          rt.notReadySince = undefined;
        }
      } else {
        const msg = 'Kubelet stopped posting node status.';
        node.status.conditions = [
          mk('MemoryPressure', 'Unknown', 'NodeStatusUnknown', msg),
          mk('DiskPressure', 'Unknown', 'NodeStatusUnknown', msg),
          mk('PIDPressure', 'Unknown', 'NodeStatusUnknown', msg),
          mk('Ready', 'Unknown', 'NodeStatusUnknown', msg),
        ];
        if (wasReady || rt.notReadySince === undefined) {
          rt.notReadySince = now;
          const taints = node.spec.taints ?? [];
          if (!taints.some((x) => x.key === 'node.kubernetes.io/unreachable')) {
            taints.push({ key: 'node.kubernetes.io/unreachable', effect: 'NoSchedule', timeAdded: t });
            taints.push({ key: 'node.kubernetes.io/unreachable', effect: 'NoExecute', timeAdded: t });
          }
          node.spec.taints = taints;
          engine.store.event({ type: 'Normal', reason: 'NodeNotReady', message: `Node ${node.metadata.name} status is now: NodeNotReady`, involved: node, component: 'node-controller' });
          // mark pods not ready (upstream: MarkPodsNotReady)
          for (const pod of engine.store.list<Pod>('Pod')) {
            if (pod.spec.nodeName !== node.metadata.name) continue;
            for (const c of pod.status.conditions ?? []) {
              if (c.type === 'Ready' || c.type === 'ContainersReady') { c.status = 'False'; c.reason = 'NodeNotReady'; c.message = undefined; c.lastTransitionTime = t; }
            }
            for (const cs of pod.status.containerStatuses ?? []) cs.ready = false;
            for (const c of engine.podRuntime(pod).containers) c.ready = false;
            engine.store.update(pod);
          }
        }
      }
      engine.store.update(node);
    }
    // taint-based eviction once tolerationSeconds elapse
    if (!rt.ready && rt.notReadySince !== undefined) {
      for (const pod of engine.store.list<Pod>('Pod')) {
        if (pod.spec.nodeName !== node.metadata.name || pod.metadata.deletionTimestamp) continue;
        const tol = pod.spec.tolerations?.find((x) => x.key === 'node.kubernetes.io/unreachable' && x.effect === 'NoExecute');
        if (tol && tol.tolerationSeconds === undefined) continue; // tolerates forever (e.g. DaemonSets)
        const seconds = tol?.tolerationSeconds ?? 0;
        if (now - rt.notReadySince >= seconds * 1000) {
          engine.store.event({ type: 'Normal', reason: 'TaintManagerEviction', message: `Marking for deletion Pod ${pod.metadata.namespace}/${pod.metadata.name}`, involved: pod, component: 'taint-eviction-controller' });
          engine.store.markDeleting(pod, pod.spec.terminationGracePeriodSeconds ?? 30);
        }
      }
    }
  }
  // pods stuck Terminating on a lost node are force-removed by the GC after a while (not needed for MVP)
}

/** Chaos / mission helper: take a node down or up. */
export function setNodeReady(engine: Engine, name: string, ready: boolean): void {
  engine.nodeRuntime(name).ready = ready;
}
