/** Default scheduler: filter nodes, score by least-requested, bind. Messages mirror upstream. */
import type { Engine } from '../engine.ts';
import type { Pod, Node, Toleration, Taint } from '../types.ts';
import { parseCpuMillis, parseMemoryBytes } from '../duration.ts';
import { fromLabelSelector, matches } from '../selector.ts';

export function podRequests(pod: Pod): { cpu: number; mem: number } {
  let cpu = 0, mem = 0;
  for (const c of pod.spec.containers) {
    const r = c.resources?.requests ?? {};
    if (r.cpu !== undefined) cpu += parseCpuMillis(r.cpu);
    if (r.memory !== undefined) mem += parseMemoryBytes(r.memory);
  }
  return { cpu, mem };
}

export function nodeRequested(engine: Engine, nodeName: string, exclude?: Pod): { cpu: number; mem: number; pods: number } {
  let cpu = 0, mem = 0, pods = 0;
  for (const p of engine.store.list<Pod>('Pod')) {
    if (p.spec.nodeName !== nodeName || p === exclude) continue;
    if (p.status.phase === 'Succeeded' || p.status.phase === 'Failed') continue;
    const r = podRequests(p);
    cpu += r.cpu; mem += r.mem; pods++;
  }
  return { cpu, mem, pods };
}

export function tolerates(tolerations: Toleration[] | undefined, taint: Taint): boolean {
  for (const t of tolerations ?? []) {
    if (t.effect && t.effect !== taint.effect) continue;
    if (t.key && t.key !== taint.key) continue;
    if (!t.key && t.operator !== 'Exists') continue;
    if ((t.operator ?? 'Equal') === 'Exists') return true;
    if ((t.value ?? '') === (taint.value ?? '')) return true;
  }
  return false;
}

function nodeIsReady(engine: Engine, node: Node): boolean {
  return engine.nodeRuntime(node.metadata.name).ready;
}

function matchesNodeAffinity(pod: Pod, node: Node): boolean {
  const aff = pod.spec.affinity as { nodeAffinity?: { requiredDuringSchedulingIgnoredDuringExecution?: { nodeSelectorTerms: { matchExpressions?: { key: string; operator: string; values?: string[] }[]; matchFields?: { key: string; operator: string; values?: string[] }[] }[] } } } | undefined;
  const req = aff?.nodeAffinity?.requiredDuringSchedulingIgnoredDuringExecution;
  if (!req) return true;
  return req.nodeSelectorTerms.some((term) => {
    const exprOk = (term.matchExpressions ?? []).every((e) => {
      const v = node.metadata.labels?.[e.key];
      switch (e.operator) {
        case 'In': return v !== undefined && (e.values ?? []).includes(v);
        case 'NotIn': return v === undefined || !(e.values ?? []).includes(v);
        case 'Exists': return v !== undefined;
        case 'DoesNotExist': return v === undefined;
        case 'Gt': return v !== undefined && parseFloat(v) > parseFloat(e.values?.[0] ?? '0');
        case 'Lt': return v !== undefined && parseFloat(v) < parseFloat(e.values?.[0] ?? '0');
        default: return false;
      }
    });
    const fieldOk = (term.matchFields ?? []).every((f) => f.key === 'metadata.name' && (f.operator === 'In' ? (f.values ?? []).includes(node.metadata.name) : f.operator === 'NotIn' ? !(f.values ?? []).includes(node.metadata.name) : true));
    return exprOk && fieldOk;
  });
}

/** Pod anti-affinity (required) with topologyKey kubernetes.io/hostname: one per node. */
function violatesAntiAffinity(engine: Engine, pod: Pod, node: Node): boolean {
  const aff = pod.spec.affinity as { podAntiAffinity?: { requiredDuringSchedulingIgnoredDuringExecution?: { labelSelector?: { matchLabels?: Record<string, string>; matchExpressions?: { key: string; operator: 'In' | 'NotIn' | 'Exists' | 'DoesNotExist'; values?: string[] }[] }; topologyKey: string }[] } } | undefined;
  const terms = aff?.podAntiAffinity?.requiredDuringSchedulingIgnoredDuringExecution ?? [];
  for (const term of terms) {
    const reqs = fromLabelSelector(term.labelSelector);
    const topo = node.metadata.labels?.[term.topologyKey];
    for (const other of engine.store.list<Pod>('Pod', pod.metadata.namespace)) {
      if (other === pod || !other.spec.nodeName || other.metadata.deletionTimestamp) continue;
      const otherNode = engine.store.get<Node>('Node', undefined, other.spec.nodeName);
      if (!otherNode) continue;
      if (otherNode.metadata.labels?.[term.topologyKey] !== topo) continue;
      if (matches(reqs, other.metadata.labels)) return true;
    }
  }
  return false;
}

export function runScheduler(engine: Engine): void {
  const nodes = engine.store.list<Node>('Node');
  for (const pod of engine.store.list<Pod>('Pod')) {
    if (pod.spec.nodeName || pod.metadata.deletionTimestamp) continue;
    if ((pod.spec.schedulerName ?? 'default-scheduler') !== 'default-scheduler') continue;
    const sched = (engine.podRuntime(pod) as { nextScheduleAttempt?: number });
    if (sched.nextScheduleAttempt !== undefined && engine.clock.nowMs < sched.nextScheduleAttempt) continue;
    const req = podRequests(pod);
    const reasons = new Map<string, number>();
    const fail = (r: string) => reasons.set(r, (reasons.get(r) ?? 0) + 1);
    const feasible: { node: Node; score: number }[] = [];
    for (const node of nodes) {
      if (!nodeIsReady(engine, node)) {
        if (!tolerates(pod.spec.tolerations, { key: 'node.kubernetes.io/not-ready', effect: 'NoSchedule' })) { fail('node(s) had untolerated taint {node.kubernetes.io/not-ready: }'); continue; }
      }
      if (node.spec.unschedulable && !tolerates(pod.spec.tolerations, { key: 'node.kubernetes.io/unschedulable', effect: 'NoSchedule' })) { fail('node(s) were unschedulable'); continue; }
      let taintFail: string | undefined;
      for (const t of node.spec.taints ?? []) {
        if (t.effect === 'PreferNoSchedule') continue;
        if (!tolerates(pod.spec.tolerations, t)) { taintFail = `node(s) had untolerated taint {${t.key}: ${t.value ?? ''}}`; break; }
      }
      if (taintFail) { fail(taintFail); continue; }
      const sel = pod.spec.nodeSelector ?? {};
      if (!Object.entries(sel).every(([k, v]) => node.metadata.labels?.[k] === v) || !matchesNodeAffinity(pod, node)) { fail("node(s) didn't match Pod's node affinity/selector"); continue; }
      const used = nodeRequested(engine, node.metadata.name);
      const allocCpu = parseCpuMillis(node.status.allocatable.cpu ?? '0');
      const allocMem = parseMemoryBytes(node.status.allocatable.memory ?? '0');
      const allocPods = parseInt(node.status.allocatable.pods ?? '110', 10);
      if (used.pods + 1 > allocPods) { fail('Too many pods'); continue; }
      const cpuFail = used.cpu + req.cpu > allocCpu;
      const memFail = used.mem + req.mem > allocMem;
      if (cpuFail) fail('Insufficient cpu');
      if (memFail) fail('Insufficient memory');
      if (cpuFail || memFail) continue;
      if (violatesAntiAffinity(engine, pod, node)) { fail("node(s) didn't match pod anti-affinity rules"); continue; }
      // LeastAllocated scoring (upstream NodeResourcesFit, least allocated strategy) + balance
      const cpuScore = allocCpu ? ((allocCpu - used.cpu - req.cpu) / allocCpu) * 100 : 0;
      const memScore = allocMem ? ((allocMem - used.mem - req.mem) / allocMem) * 100 : 0;
      const podScore = (1 - used.pods / allocPods) * 10; // spread when requests are absent
      feasible.push({ node, score: (cpuScore + memScore) / 2 + podScore });
    }
    if (feasible.length === 0) {
      const total = nodes.length;
      const parts = [...reasons.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([r, n]) => `${n} ${r}`).join(', ');
      const msg = `0/${total} nodes are available: ${parts}. preemption: 0/${total} nodes are available: ${total} No preemption victims found for incoming pod.`;
      engine.store.event({ type: 'Warning', reason: 'FailedScheduling', message: msg, involved: pod, component: 'default-scheduler' });
      const cond = pod.status.conditions?.find((c) => c.type === 'PodScheduled');
      const t = engine.clock.iso();
      pod.status.conditions = [{ type: 'PodScheduled', status: 'False', reason: 'Unschedulable', message: msg, lastProbeTime: null, lastTransitionTime: cond?.status === 'False' ? cond.lastTransitionTime : t }];
      pod.status.phase = 'Pending';
      engine.store.update(pod);
      sched.nextScheduleAttempt = engine.clock.nowMs + 5000; // retry backoff
      continue;
    }
    feasible.sort((a, b) => b.score - a.score || (a.node.metadata.name < b.node.metadata.name ? -1 : 1));
    const best = feasible[0]!;
    const ties = feasible.filter((f) => Math.abs(f.score - best.score) < 1e-9);
    const chosen = ties.length > 1 ? engine.rng.pick(ties) : best;
    pod.spec.nodeName = chosen.node.metadata.name;
    pod.status.conditions = [{ type: 'PodScheduled', status: 'True', lastProbeTime: null, lastTransitionTime: engine.clock.iso() }];
    engine.podRuntime(pod).scheduledAt = engine.clock.nowMs;
    engine.store.event({ type: 'Normal', reason: 'Scheduled', message: `Successfully assigned ${pod.metadata.namespace}/${pod.metadata.name} to ${chosen.node.metadata.name}`, involved: pod, component: 'default-scheduler' });
    engine.store.update(pod);
  }
}
