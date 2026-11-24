/** Horizontal Pod Autoscaler (autoscaling/v2): resource utilization and per-pod metrics. upstream: pkg/controller/podautoscaler */
import type { Engine } from '../engine.ts';
import type { HorizontalPodAutoscaler, Pod, Deployment, StatefulSet, Condition, LabelSelector } from '../types.ts';
import { fromLabelSelector, matches } from '../selector.ts';
import { isPodReady, podUsage } from './kubelet.ts';
import { parseCpuMillis, parseMemoryBytes, parseQuantity, formatMemory } from '../duration.ts';

const SYNC_MS = 15_000;
const TOLERANCE = 0.1;
const DOWNSCALE_WINDOW_S = 300;

interface HpaState { nextSync: number; recommendations: { at: number; replicas: number }[] }

function milli(n: number): string {
  // metric quantities are printed in milli-units unless whole (upstream resource.Quantity)
  return Number.isInteger(n) ? String(n) : `${Math.round(n * 1000)}m`;
}

export function runHpaController(engine: Engine): void {
  const hpas = engine.store.list<HorizontalPodAutoscaler>('HorizontalPodAutoscaler');
  if (!hpas.length) return;
  const now = engine.clock.nowMs;
  for (const hpa of hpas) {
    const key = `hpa:${hpa.metadata.uid}`;
    const st = (engine.scratch.get(key) as HpaState | undefined) ?? { nextSync: now + 2000, recommendations: [] };
    engine.scratch.set(key, st);
    if (now < st.nextSync) continue;
    st.nextSync = now + SYNC_MS;
    const t = engine.clock.iso();
    const ev = (type: 'Normal' | 'Warning', reason: string, message: string) => engine.store.event({ type, reason, message, involved: hpa, component: 'horizontal-pod-autoscaler' });
    const prevConds = hpa.status?.conditions ?? [];
    const cond = (type: string, ok: boolean, reason: string, message: string): Condition => {
      const prev = prevConds.find((c) => c.type === type);
      const status = ok ? 'True' : 'False';
      return { type, status, reason, message, lastTransitionTime: prev && prev.status === status ? prev.lastTransitionTime : t };
    };
    const ref = hpa.spec.scaleTargetRef;
    const target = engine.store.get<Deployment | StatefulSet>(ref.kind, hpa.metadata.namespace, ref.name);
    const status: HorizontalPodAutoscaler['status'] = { ...(hpa.status ?? {}) };
    const finish = (): void => { if (JSON.stringify(status) !== JSON.stringify(hpa.status)) { hpa.status = status; engine.store.update(hpa); } };
    if (!target || (ref.kind !== 'Deployment' && ref.kind !== 'StatefulSet')) {
      const msg = `the HPA controller was unable to get the target's current scale: ${ref.kind.toLowerCase()}s.apps "${ref.name}" not found`;
      status.conditions = [cond('AbleToScale', false, 'FailedGetScale', msg)];
      ev('Warning', 'FailedGetScale', `${ref.kind.toLowerCase()}s.apps "${ref.name}" not found`);
      finish();
      continue;
    }
    const current = target.spec.replicas ?? 1;
    const min = hpa.spec.minReplicas ?? 1, max = hpa.spec.maxReplicas;
    const reqs = fromLabelSelector(target.spec.selector as LabelSelector);
    const pods = engine.store.list<Pod>('Pod', hpa.metadata.namespace).filter((p) => matches(reqs, p.metadata.labels) && !p.metadata.deletionTimestamp && p.status.phase !== 'Succeeded' && p.status.phase !== 'Failed');
    const ready = pods.filter(isPodReady);
    status.currentReplicas = current;
    status.observedGeneration = hpa.metadata.generation;
    const metrics = hpa.spec.metrics?.length ? hpa.spec.metrics : [{ type: 'Resource' as const, resource: { name: 'cpu', target: { type: 'Utilization' as const, averageUtilization: 80 } } }];
    let proposal = 0, metricName = '', error: string | undefined;
    const currentMetrics: NonNullable<HorizontalPodAutoscaler['status']['currentMetrics']> = [];
    for (const m of metrics) {
      let ratio: number | undefined, name = '';
      if (m.type === 'Resource' && m.resource) {
        const res = m.resource.name;
        const usageOf = (p: Pod): number => { const u = podUsage(engine, p); return res === 'cpu' ? u.cpuMillis : u.memoryBytes; };
        const parse = (v: string | number): number => (res === 'cpu' ? parseCpuMillis(v) : parseMemoryBytes(v));
        const fmt = (v: number): string => (res === 'cpu' ? `${Math.round(v)}m` : formatMemory(Math.round(v)));
        if (m.resource.target.type === 'Utilization') {
          name = `${res} resource utilization (percentage of request)`;
          let missing: string | undefined;
          for (const p of pods) for (const c of p.spec.containers) if (c.resources?.requests?.[res] === undefined && !missing) missing = `missing request for ${res} in container ${c.name} of Pod ${p.metadata.name}`;
          if (missing) { error = `failed to get ${res} utilization: ${missing}`; currentMetrics.push({ type: 'Resource' }); break; }
          if (!ready.length) { error = `failed to get ${res} utilization: did not receive metrics for targeted pods (pods might be unready)`; currentMetrics.push({ type: 'Resource' }); break; }
          const usage = ready.reduce((n, p) => n + usageOf(p), 0);
          const requested = ready.reduce((n, p) => n + p.spec.containers.reduce((k, c) => k + parse(c.resources?.requests?.[res] ?? 0), 0), 0);
          const util = Math.round((usage / requested) * 100);
          ratio = util / (m.resource.target.averageUtilization ?? 80);
          currentMetrics.push({ type: 'Resource', resource: { name: res, current: { averageUtilization: util, averageValue: fmt(usage / ready.length) } } });
        } else {
          name = `${res} resource`;
          if (!ready.length) { error = `failed to get ${res} usage: did not receive metrics for targeted pods (pods might be unready)`; currentMetrics.push({ type: 'Resource' }); break; }
          const avg = ready.reduce((n, p) => n + usageOf(p), 0) / ready.length;
          ratio = avg / parse(m.resource.target.averageValue ?? '1');
          currentMetrics.push({ type: 'Resource', resource: { name: res, current: { averageValue: fmt(avg) } } });
        }
      } else if (m.type === 'Pods' && m.pods) {
        name = `pods metric ${m.pods.metric.name}`;
        // per-pod custom metrics come from an adapter (e.g. prometheus-adapter); the simulator serves the request rate
        if (!engine.customMetrics.includes(m.pods.metric.name)) { error = `unable to get metric ${m.pods.metric.name}: unable to fetch metrics from custom metrics API: the server could not find the metric ${m.pods.metric.name} for pods`; currentMetrics.push({ type: 'Pods' }); break; }
        if (!ready.length) { error = `unable to get metric ${m.pods.metric.name}: no metrics returned from custom metrics API`; currentMetrics.push({ type: 'Pods' }); break; }
        const avg = ready.reduce((n, p) => n + engine.traffic.podRate(p.metadata.uid as string), 0) / ready.length;
        ratio = avg / parseQuantity(m.pods.target.averageValue ?? '1');
        currentMetrics.push({ type: 'Pods', pods: { metric: { name: m.pods.metric.name }, current: { averageValue: milli(Math.round(avg * 1000) / 1000) } } });
      } else { error = `kubequest: HPA metric type ${m.type} is not supported in the simulator yet`; break; }
      const base = ready.length || current;
      const want = Math.abs(ratio - 1) <= TOLERANCE ? current : Math.ceil(ratio * base);
      if (want > proposal) { proposal = want; metricName = name; }
    }
    status.currentMetrics = currentMetrics;
    if (error !== undefined) {
      const kind = metrics.find((m) => m.type === 'Pods') && error.startsWith('unable to get metric') ? 'FailedGetPodsMetric' : 'FailedGetResourceMetric';
      status.conditions = [cond('AbleToScale', true, 'SucceededGetScale', "the HPA controller was able to get the target's current scale"), cond('ScalingActive', false, kind, `the HPA was unable to compute the replica count: ${error}`)];
      status.desiredReplicas = 0;
      ev('Warning', kind, error);
      ev('Warning', 'FailedComputeMetricsReplicas', `invalid metrics (1 invalid out of ${metrics.length}), first error is: failed to get ${kind === 'FailedGetPodsMetric' ? 'pods metric value' : `${metrics[0]?.resource?.name ?? 'cpu'} resource metric value`}: ${error}`);
      finish();
      continue;
    }
    // behaviour: scale-up at most max(2x, +4) per sync; scale-down uses the highest recommendation in the stabilization window
    const upLimit = Math.max(current * 2, current + 4);
    let desired = Math.min(proposal, upLimit);
    const window = (hpa.spec.behavior?.scaleDown?.stabilizationWindowSeconds ?? DOWNSCALE_WINDOW_S) * 1000;
    st.recommendations = st.recommendations.filter((r) => now - r.at <= window);
    st.recommendations.push({ at: now, replicas: desired });
    let stabilized = false;
    if (desired < current) {
      const highest = Math.max(...st.recommendations.map((r) => r.replicas));
      if (highest > desired) { desired = Math.min(highest, current); stabilized = true; }
    }
    let limited: [string, string] | undefined;
    if (desired > max) { desired = max; limited = ['TooManyReplicas', 'the desired replica count is more than the maximum replica count']; }
    else if (desired < min) { desired = min; limited = ['TooFewReplicas', 'the desired replica count is less than the minimum replica count']; }
    status.desiredReplicas = desired;
    let able = cond('AbleToScale', true, 'ReadyForNewScale', 'recommended size matches current size');
    if (stabilized) able = cond('AbleToScale', true, 'ScaleDownStabilized', 'recent recommendations were higher than current one, applying the highest recent recommendation');
    if (desired !== current) {
      target.spec.replicas = desired;
      engine.store.update(target, { specChanged: true });
      status.lastScaleTime = t;
      able = cond('AbleToScale', true, 'SucceededRescale', `the HPA controller was able to update the target scale to ${desired}`);
      const reason = desired > current ? (current < min ? 'Current number of replicas below Spec.MinReplicas' : `${metricName} above target`) : current > max ? 'Current number of replicas above Spec.MaxReplicas' : 'All metrics below target';
      ev('Normal', 'SuccessfulRescale', `New size: ${desired}; reason: ${reason}`);
    }
    status.conditions = [able, cond('ScalingActive', true, 'ValidMetricFound', `the HPA was able to successfully calculate a replica count from ${metricName}`), limited ? cond('ScalingLimited', true, limited[0], limited[1]) : cond('ScalingLimited', false, 'DesiredWithinRange', 'the desired count is within the acceptable range')];
    finish();
  }
}
