/** Default scheduler: filter nodes, score by least-requested, bind; preempt for higher-priority pods. Messages mirror upstream. */
import type { Engine } from '../engine.ts';
import type { Pod, Node, Toleration, Taint, PersistentVolumeClaim, StorageClass, LabelSelector, TopologySpreadConstraint } from '../types.ts';
import { parseCpuMillis, parseMemoryBytes, parseQuantity } from '../duration.ts';
import { fromLabelSelector, matches } from '../selector.ts';
import { SELECTED_NODE } from './storage.ts';

export interface Requests { cpu: number; mem: number; ext: Record<string, number> }

/** Effective requests of a pod: the sum of its containers (extended resources such as nvidia.com/gpu included). */
export function podRequests(pod: Pod): Requests {
  let cpu = 0, mem = 0;
  const ext: Record<string, number> = {};
  for (const c of pod.spec.containers) {
    for (const [k, v] of Object.entries(c.resources?.requests ?? {})) {
      if (k === 'cpu') cpu += parseCpuMillis(v);
      else if (k === 'memory') mem += parseMemoryBytes(v);
      else if (k !== 'ephemeral-storage') ext[k] = (ext[k] ?? 0) + parseQuantity(v);
    }
  }
  return { cpu, mem, ext };
}

export function nodeRequested(engine: Engine, nodeName: string, exclude?: Set<Pod> | Pod): { cpu: number; mem: number; pods: number; ext: Record<string, number> } {
  let cpu = 0, mem = 0, pods = 0;
  const ext: Record<string, number> = {};
  const skip = exclude instanceof Set ? exclude : exclude ? new Set([exclude]) : undefined;
  for (const p of engine.store.list<Pod>('Pod')) {
    if (p.spec.nodeName !== nodeName || skip?.has(p)) continue;
    if (p.status.phase === 'Succeeded' || p.status.phase === 'Failed') continue;
    const r = podRequests(p);
    cpu += r.cpu; mem += r.mem; pods++;
    for (const [k, v] of Object.entries(r.ext)) ext[k] = (ext[k] ?? 0) + v;
  }
  return { cpu, mem, pods, ext };
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

/** Preferred node affinity adds its weights to the score (soft constraint). */
function preferredNodeScore(pod: Pod, node: Node): number {
  const prefs = ((pod.spec.affinity as { nodeAffinity?: { preferredDuringSchedulingIgnoredDuringExecution?: { weight: number; preference: { matchExpressions?: { key: string; operator: string; values?: string[] }[] } }[] } } | undefined)?.nodeAffinity?.preferredDuringSchedulingIgnoredDuringExecution) ?? [];
  let score = 0;
  for (const p of prefs) {
    const ok = (p.preference.matchExpressions ?? []).every((e) => { const v = node.metadata.labels?.[e.key]; return e.operator === 'In' ? v !== undefined && (e.values ?? []).includes(v) : e.operator === 'Exists' ? v !== undefined : e.operator === 'NotIn' ? v === undefined || !(e.values ?? []).includes(v) : e.operator === 'DoesNotExist' ? v === undefined : false; });
    if (ok) score += p.weight;
  }
  return score;
}

interface PodAffinityTerm { labelSelector?: LabelSelector; topologyKey: string; namespaces?: string[] }

/** Required inter-pod (anti-)affinity: is there a matching pod in the node's topology domain? */
function matchingPodInDomain(engine: Engine, pod: Pod, node: Node, term: PodAffinityTerm, nodes: Node[]): boolean {
  const reqs = fromLabelSelector(term.labelSelector);
  const topo = node.metadata.labels?.[term.topologyKey];
  if (topo === undefined) return false;
  for (const other of engine.store.list<Pod>('Pod', pod.metadata.namespace)) {
    if (other === pod || !other.spec.nodeName || other.metadata.deletionTimestamp) continue;
    const otherNode = nodes.find((n) => n.metadata.name === other.spec.nodeName);
    if (!otherNode || otherNode.metadata.labels?.[term.topologyKey] !== topo) continue;
    if (matches(reqs, other.metadata.labels)) return true;
  }
  return false;
}

function affinityTerms(pod: Pod, kind: 'podAffinity' | 'podAntiAffinity'): PodAffinityTerm[] {
  return ((pod.spec.affinity as Record<string, { requiredDuringSchedulingIgnoredDuringExecution?: PodAffinityTerm[] }> | undefined)?.[kind]?.requiredDuringSchedulingIgnoredDuringExecution) ?? [];
}

/**
 * The Pods a spread constraint counts: `labelSelector` AND, for every key in `matchLabelKeys` that the
 * incoming Pod carries, that same value (upstream: podtopologyspread/common.go — missing keys are ignored).
 */
function spreadSelector(pod: Pod, c: TopologySpreadConstraint): ReturnType<typeof fromLabelSelector> {
  const matchLabels: Record<string, string> = { ...(c.labelSelector?.matchLabels ?? {}) };
  for (const key of c.matchLabelKeys ?? []) { const v = pod.metadata.labels?.[key]; if (v !== undefined) matchLabels[key] = v; }
  return fromLabelSelector({ ...(c.labelSelector ?? {}), matchLabels });
}

/** upstream PodTopologySpread: placing the pod here must keep every DoNotSchedule constraint within maxSkew. */
function spreadViolation(engine: Engine, pod: Pod, node: Node, eligible: Node[]): 'label' | 'skew' | undefined {
  for (const c of pod.spec.topologySpreadConstraints ?? []) {
    if (c.whenUnsatisfiable !== 'DoNotSchedule') continue;
    const domain = node.metadata.labels?.[c.topologyKey];
    if (domain === undefined) return 'label';
    const counts = new Map<string, number>();
    for (const n of eligible) { const d = n.metadata.labels?.[c.topologyKey]; if (d !== undefined) counts.set(d, counts.get(d) ?? 0); }
    const reqs = spreadSelector(pod, c);
    for (const other of engine.store.list<Pod>('Pod', pod.metadata.namespace)) {
      if (other === pod || !other.spec.nodeName || other.metadata.deletionTimestamp || !matches(reqs, other.metadata.labels)) continue;
      const d = eligible.find((n) => n.metadata.name === other.spec.nodeName)?.metadata.labels?.[c.topologyKey];
      if (d !== undefined) counts.set(d, (counts.get(d) ?? 0) + 1);
    }
    const min = Math.min(...counts.values());
    if ((counts.get(domain) ?? 0) + 1 - min > c.maxSkew) return 'skew';
  }
  return undefined;
}

function spreadScore(engine: Engine, pod: Pod, node: Node): number {
  let score = 0;
  for (const c of pod.spec.topologySpreadConstraints ?? []) {
    if (c.whenUnsatisfiable !== 'ScheduleAnyway') continue;
    const domain = node.metadata.labels?.[c.topologyKey];
    const reqs = spreadSelector(pod, c);
    let same = 0;
    for (const other of engine.store.list<Pod>('Pod', pod.metadata.namespace)) {
      if (other === pod || !other.spec.nodeName || other.metadata.deletionTimestamp || !matches(reqs, other.metadata.labels)) continue;
      if (engine.store.get<Node>('Node', undefined, other.spec.nodeName)?.metadata.labels?.[c.topologyKey] === domain) same++;
    }
    score -= same * 20;
  }
  return score;
}

/** Reasons that removing pods cannot fix (upstream: UnschedulableAndUnresolvable). */
const UNRESOLVABLE = /^node\(s\) (had untolerated taint|were unschedulable|didn't match Pod's node affinity\/selector|didn't match pod topology spread constraints \(missing required label\))/;

interface NodeVerdict { node: Node; reasons: string[]; score: number }

function evaluate(engine: Engine, pod: Pod, node: Node, nodes: Node[], eligible: Node[], ignore?: Set<Pod>): NodeVerdict {
  const reasons: string[] = [];
  const verdict = (r: string): NodeVerdict => ({ node, reasons: [r], score: 0 });
  if (!engine.nodeRuntime(node.metadata.name).ready && !tolerates(pod.spec.tolerations, { key: 'node.kubernetes.io/not-ready', effect: 'NoSchedule' })) return verdict('node(s) had untolerated taint {node.kubernetes.io/not-ready: }');
  if (node.spec.unschedulable && !tolerates(pod.spec.tolerations, { key: 'node.kubernetes.io/unschedulable', effect: 'NoSchedule' })) return verdict('node(s) were unschedulable');
  for (const t of node.spec.taints ?? []) {
    if (t.effect === 'PreferNoSchedule') continue;
    if (!tolerates(pod.spec.tolerations, t)) return verdict(`node(s) had untolerated taint {${t.key}: ${t.value ?? ''}}`);
  }
  const sel = pod.spec.nodeSelector ?? {};
  if (!Object.entries(sel).every(([k, v]) => node.metadata.labels?.[k] === v) || !matchesNodeAffinity(pod, node)) return verdict("node(s) didn't match Pod's node affinity/selector");
  const req = podRequests(pod);
  const used = nodeRequested(engine, node.metadata.name, ignore);
  // capacity freed by preemption is held for the pod it was freed for (upstream: nominated pods are assumed on their node)
  for (const other of engine.store.list<Pod>('Pod')) {
    if (other === pod || other.spec.nodeName || other.metadata.deletionTimestamp || other.status.nominatedNodeName !== node.metadata.name || (other.spec.priority ?? 0) < (pod.spec.priority ?? 0)) continue;
    const r = podRequests(other);
    used.cpu += r.cpu; used.mem += r.mem; used.pods++;
    for (const [k, v] of Object.entries(r.ext)) used.ext[k] = (used.ext[k] ?? 0) + v;
  }
  const alloc = node.status.allocatable;
  const allocCpu = parseCpuMillis(alloc.cpu ?? '0'), allocMem = parseMemoryBytes(alloc.memory ?? '0'), allocPods = parseInt(alloc.pods ?? '110', 10);
  if (used.pods + 1 > allocPods) reasons.push('Too many pods');
  if (used.cpu + req.cpu > allocCpu) reasons.push('Insufficient cpu');
  if (used.mem + req.mem > allocMem) reasons.push('Insufficient memory');
  for (const [k, v] of Object.entries(req.ext)) if ((used.ext[k] ?? 0) + v > parseQuantity(alloc[k] ?? '0')) reasons.push(`Insufficient ${k}`);
  if (reasons.length) return { node, reasons, score: 0 };
  if (affinityTerms(pod, 'podAffinity').some((t) => !matchingPodInDomain(engine, pod, node, t, nodes))) return verdict("node(s) didn't match pod affinity rules");
  if (affinityTerms(pod, 'podAntiAffinity').some((t) => matchingPodInDomain(engine, pod, node, t, nodes))) return verdict("node(s) didn't match pod anti-affinity rules");
  const spread = spreadViolation(engine, pod, node, eligible);
  if (spread) return verdict(spread === 'label' ? "node(s) didn't match pod topology spread constraints (missing required label)" : "node(s) didn't match pod topology spread constraints");
  // LeastAllocated scoring (upstream NodeResourcesFit) + pod-count balance, node-affinity preferences, soft spread
  const cpuScore = allocCpu ? ((allocCpu - used.cpu - req.cpu) / allocCpu) * 100 : 0;
  const memScore = allocMem ? ((allocMem - used.mem - req.mem) / allocMem) * 100 : 0;
  const prefer = (node.spec.taints ?? []).some((t) => t.effect === 'PreferNoSchedule' && !tolerates(pod.spec.tolerations, t)) ? -50 : 0;
  return { node, reasons: [], score: (cpuScore + memScore) / 2 + (1 - used.pods / allocPods) * 10 + preferredNodeScore(pod, node) + spreadScore(engine, pod, node) + prefer };
}

/** Volume binding PreFilter: claims must exist and immediate-binding claims must be bound before scheduling. */
function volumePrefilter(engine: Engine, pod: Pod): { fail?: string; waiting: PersistentVolumeClaim[] } {
  const waiting: PersistentVolumeClaim[] = [];
  for (const v of pod.spec.volumes ?? []) {
    if (!v.persistentVolumeClaim) continue;
    const pvc = engine.store.get<PersistentVolumeClaim>('PersistentVolumeClaim', pod.metadata.namespace, v.persistentVolumeClaim.claimName);
    if (!pvc) return { fail: `persistentvolumeclaim "${v.persistentVolumeClaim.claimName}" not found`, waiting };
    if (pvc.metadata.deletionTimestamp) return { fail: `persistentvolumeclaim "${pvc.metadata.name}" is being deleted`, waiting };
    if (pvc.status?.phase === 'Bound') continue;
    const sc = pvc.spec.storageClassName ? engine.store.get<StorageClass>('StorageClass', undefined, pvc.spec.storageClassName) : undefined;
    if (sc && (sc.volumeBindingMode ?? 'Immediate') === 'WaitForFirstConsumer') waiting.push(pvc);
    else return { fail: 'pod has unbound immediate PersistentVolumeClaims', waiting };
  }
  return { waiting };
}

function unschedulable(engine: Engine, pod: Pod, msg: string): void {
  engine.store.event({ type: 'Warning', reason: 'FailedScheduling', message: msg, involved: pod, component: 'default-scheduler' });
  const cond = pod.status.conditions?.find((c) => c.type === 'PodScheduled');
  pod.status.conditions = [{ type: 'PodScheduled', status: 'False', reason: 'Unschedulable', message: msg, lastProbeTime: null, lastTransitionTime: cond?.status === 'False' ? cond.lastTransitionTime : engine.clock.iso() }];
  pod.status.phase = 'Pending';
  engine.store.update(pod);
}

/** upstream DefaultPreemption: evict lower-priority pods from one node so the pending pod fits there. */
function preempt(engine: Engine, pod: Pod, verdicts: NodeVerdict[], nodes: Node[], eligible: Node[]): Node | undefined {
  const prio = pod.spec.priority ?? 0;
  let best: { node: Node; victims: Pod[]; top: number } | undefined;
  for (const v of verdicts) {
    if (v.reasons.some((r) => UNRESOLVABLE.test(r))) continue;
    const lower = engine.store.list<Pod>('Pod').filter((p) => p.spec.nodeName === v.node.metadata.name && !p.metadata.deletionTimestamp && (p.spec.priority ?? 0) < prio && p.status.phase !== 'Succeeded' && p.status.phase !== 'Failed')
      .sort((a, b) => (a.spec.priority ?? 0) - (b.spec.priority ?? 0) || Date.parse(b.metadata.creationTimestamp ?? '') - Date.parse(a.metadata.creationTimestamp ?? ''));
    const victims = new Set<Pod>();
    let fits = false;
    for (const cand of lower) {
      victims.add(cand);
      if (evaluate(engine, pod, v.node, nodes, eligible, victims).reasons.length === 0) { fits = true; break; }
    }
    if (!fits) continue;
    const list = [...victims];
    const top = Math.max(...list.map((p) => p.spec.priority ?? 0));
    if (!best || top < best.top || (top === best.top && list.length < best.victims.length)) best = { node: v.node, victims: list, top };
  }
  if (!best) return undefined;
  const t = engine.clock.iso();
  for (const victim of best.victims) {
    engine.store.event({ type: 'Normal', reason: 'Preempted', message: `Preempted by pod ${pod.metadata.uid} on node ${best.node.metadata.name}`, involved: victim, component: 'default-scheduler' });
    victim.status.conditions = [...(victim.status.conditions ?? []).filter((c) => c.type !== 'DisruptionTarget'), { type: 'DisruptionTarget', status: 'True', reason: 'PreemptionByScheduler', message: 'default-scheduler: preempting to accommodate a higher priority pod', lastProbeTime: null, lastTransitionTime: t }];
    engine.store.markDeleting(victim, victim.spec.terminationGracePeriodSeconds ?? 30);
  }
  return best.node;
}

export function runScheduler(engine: Engine): void {
  const pending = engine.store.list<Pod>('Pod').filter((p) => !p.spec.nodeName && !p.metadata.deletionTimestamp && (p.spec.schedulerName ?? 'default-scheduler') === 'default-scheduler');
  if (!pending.length) return;
  // the scheduling queue is ordered by priority, then age
  pending.sort((a, b) => (b.spec.priority ?? 0) - (a.spec.priority ?? 0) || Date.parse(a.metadata.creationTimestamp ?? '') - Date.parse(b.metadata.creationTimestamp ?? ''));
  const nodes = engine.store.list<Node>('Node');
  for (const pod of pending) {
    const sched = (engine.podRuntime(pod) as { nextScheduleAttempt?: number });
    if (sched.nextScheduleAttempt !== undefined && engine.clock.nowMs < sched.nextScheduleAttempt) continue;
    const total = nodes.length;
    const vol = volumePrefilter(engine, pod);
    if (vol.fail) {
      unschedulable(engine, pod, `0/${total} nodes are available: ${vol.fail}. preemption: 0/${total} nodes are available: ${total} Preemption is not helpful for scheduling.`);
      sched.nextScheduleAttempt = engine.clock.nowMs + 5000;
      continue;
    }
    // nodes that pass node affinity/selector define the topology domains for spread constraints
    const eligible = nodes.filter((n) => Object.entries(pod.spec.nodeSelector ?? {}).every(([k, v]) => n.metadata.labels?.[k] === v) && matchesNodeAffinity(pod, n) && !(n.spec.taints ?? []).some((t) => t.effect === 'NoSchedule' && !tolerates(pod.spec.tolerations, t)));
    const verdicts = nodes.map((n) => evaluate(engine, pod, n, nodes, eligible));
    const feasible = verdicts.filter((v) => v.reasons.length === 0);
    if (feasible.length === 0) {
      const reasons = new Map<string, number>();
      for (const v of verdicts) for (const r of v.reasons) reasons.set(r, (reasons.get(r) ?? 0) + 1);
      const parts = [...reasons.entries()].map(([r, n]) => `${n} ${r}`).sort().join(', ');
      let suffix: string;
      if (pod.spec.preemptionPolicy === 'Never') suffix = ' preemption: not eligible due to preemptionPolicy=Never.';
      else {
        const nominated = (pod.spec.priority ?? 0) > 0 ? preempt(engine, pod, verdicts, nodes, eligible) : undefined;
        if (nominated) { pod.status.nominatedNodeName = nominated.metadata.name; suffix = ''; }
        else {
          const hard = verdicts.filter((v) => v.reasons.some((r) => UNRESOLVABLE.test(r))).length;
          const pre = [total - hard ? `${total - hard} No preemption victims found for incoming pod` : '', hard ? `${hard} Preemption is not helpful for scheduling` : ''].filter((x) => x).sort().join(', ');
          suffix = ` preemption: 0/${total} nodes are available: ${pre}.`;
        }
      }
      unschedulable(engine, pod, `0/${total} nodes are available: ${parts}.${suffix}`);
      sched.nextScheduleAttempt = engine.clock.nowMs + (pod.status.nominatedNodeName ? 1000 : 5000); // retry backoff (victims terminating: come back soon)
      continue;
    }
    feasible.sort((a, b) => b.score - a.score || (a.node.metadata.name < b.node.metadata.name ? -1 : 1));
    const best = feasible[0]!;
    const ties = feasible.filter((f) => Math.abs(f.score - best.score) < 1e-9);
    const chosen = ties.length > 1 ? engine.rng.pick(ties) : best;
    pod.spec.nodeName = chosen.node.metadata.name;
    delete pod.status.nominatedNodeName;
    pod.status.conditions = [{ type: 'PodScheduled', status: 'True', lastProbeTime: null, lastTransitionTime: engine.clock.iso() }];
    engine.podRuntime(pod).scheduledAt = engine.clock.nowMs;
    // WaitForFirstConsumer claims learn where their first consumer landed; the provisioner takes it from there
    for (const pvc of vol.waiting) { pvc.metadata.annotations = { ...(pvc.metadata.annotations ?? {}), [SELECTED_NODE]: chosen.node.metadata.name }; engine.store.update(pvc); }
    engine.store.event({ type: 'Normal', reason: 'Scheduled', message: `Successfully assigned ${pod.metadata.namespace}/${pod.metadata.name} to ${chosen.node.metadata.name}`, involved: pod, component: 'default-scheduler' });
    engine.store.update(pod);
  }
}
