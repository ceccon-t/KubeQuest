/** Job and CronJob controllers (core semantics). upstream: pkg/controller/job, pkg/controller/cronjob */
import type { Engine } from '../engine.ts';
import type { Job, CronJob, Pod, Condition } from '../types.ts';
import { applyDefaults } from '../defaults.ts';
import { isPodReady } from './kubelet.ts';

export function jobPods(engine: Engine, job: Job): Pod[] {
  return engine.store.ownedBy<Pod>(job, 'Pod');
}

function newJobPod(engine: Engine, job: Job, index?: number): Pod {
  const tpl = job.spec.template;
  const labels: Record<string, string> = { ...(tpl.metadata.labels ?? {}), 'batch.kubernetes.io/controller-uid': job.metadata.uid as string, 'batch.kubernetes.io/job-name': job.metadata.name, 'controller-uid': job.metadata.uid as string, 'job-name': job.metadata.name };
  const annotations: Record<string, string> = { ...(tpl.metadata.annotations ?? {}) };
  if (index !== undefined) { labels['batch.kubernetes.io/job-completion-index'] = String(index); annotations['batch.kubernetes.io/job-completion-index'] = String(index); }
  const pod: Pod = {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name: index !== undefined ? `${job.metadata.name}-${index}-${engine.rng.suffix()}` : `${job.metadata.name}-${engine.rng.suffix()}`,
      namespace: job.metadata.namespace,
      labels,
      ...(Object.keys(annotations).length ? { annotations } : {}),
      ownerReferences: [engine.store.ownerRef(job)],
    },
    spec: structuredClone(tpl.spec),
    status: { phase: 'Pending' },
  };
  return applyDefaults(pod, engine);
}

export function runJobController(engine: Engine): void {
  const now = engine.clock.nowMs;
  for (const job of engine.store.list<Job>('Job')) {
    if (job.metadata.deletionTimestamp) continue;
    const finished = job.status.conditions?.some((c) => (c.type === 'Complete' || c.type === 'Failed') && c.status === 'True');
    if (finished) {
      const ttl = job.spec.ttlSecondsAfterFinished;
      if (ttl !== undefined && job.status.completionTime && now - Date.parse(job.status.completionTime) >= ttl * 1000) engine.store.markDeleting(job, 0);
      continue;
    }
    if (job.spec.suspend) continue;
    const pods = jobPods(engine, job);
    const active = pods.filter((p) => !p.metadata.deletionTimestamp && p.status.phase !== 'Succeeded' && p.status.phase !== 'Failed');
    const succeeded = pods.filter((p) => p.status.phase === 'Succeeded');
    const failed = pods.filter((p) => p.status.phase === 'Failed');
    const completions = job.spec.completions ?? 1;
    const parallelism = job.spec.parallelism ?? 1;
    const backoffLimit = job.spec.backoffLimit ?? 6;
    const indexed = job.spec.completionMode === 'Indexed';
    if (!job.status.startTime) job.status.startTime = engine.clock.iso();
    const t = engine.clock.iso();
    const conds: Condition[] = [];
    // failure accounting: with restartPolicy Never each failed pod counts; OnFailure counts container restarts
    const restarts = active.reduce((n, p) => n + (p.status.containerStatuses ?? []).reduce((m, c) => m + c.restartCount, 0), 0);
    const failures = failed.length + ((job.spec.template.spec.restartPolicy ?? 'Never') === 'OnFailure' ? restarts : 0);
    if (failures > backoffLimit) {
      for (const p of active) engine.store.markDeleting(p, p.spec.terminationGracePeriodSeconds ?? 30);
      conds.push({ type: 'Failed', status: 'True', reason: 'BackoffLimitExceeded', message: 'Job has reached the specified backoff limit', lastProbeTime: t, lastTransitionTime: t });
      job.status.conditions = conds;
      job.status.failed = failed.length;
      job.status.active = 0;
      job.status.completionTime = t;
      engine.store.event({ type: 'Warning', reason: 'BackoffLimitExceeded', message: 'Job has reached the specified backoff limit', involved: job, component: 'job-controller' });
      engine.store.update(job);
      continue;
    }
    const succeededIdx = new Set(succeeded.map((p) => p.metadata.annotations?.['batch.kubernetes.io/job-completion-index']));
    if (succeeded.length >= completions || (indexed && Array.from({ length: completions }, (_, i) => String(i)).every((i) => succeededIdx.has(i)))) {
      conds.push({ type: 'SuccessCriteriaMet', status: 'True', reason: 'CompletionsReached', message: 'Reached expected number of succeeded pods', lastProbeTime: t, lastTransitionTime: t });
      conds.push({ type: 'Complete', status: 'True', reason: 'CompletionsReached', message: 'Reached expected number of succeeded pods', lastProbeTime: t, lastTransitionTime: t });
      job.status.conditions = conds;
      job.status.succeeded = succeeded.length;
      delete job.status.active;
      job.status.completionTime = t;
      engine.store.event({ type: 'Normal', reason: 'Completed', message: 'Job completed', involved: job, component: 'job-controller' });
      engine.store.update(job);
      continue;
    }
    const remaining = completions - succeeded.length;
    const want = Math.min(parallelism, remaining);
    if (active.length < want) {
      const activeIdx = new Set(active.map((p) => p.metadata.annotations?.['batch.kubernetes.io/job-completion-index']));
      let nextIdx = 0;
      for (let i = active.length; i < want; i++) {
        let index: number | undefined;
        if (indexed) {
          while (succeededIdx.has(String(nextIdx)) || activeIdx.has(String(nextIdx))) nextIdx++;
          index = nextIdx;
          activeIdx.add(String(nextIdx));
        }
        const pod = newJobPod(engine, job, index);
        engine.store.create(pod);
        engine.store.event({ type: 'Normal', reason: 'SuccessfulCreate', message: `Created pod: ${pod.metadata.name}`, involved: job, component: 'job-controller' });
        active.push(pod);
      }
    } else if (active.length > want) {
      for (const p of active.slice(want)) {
        engine.store.markDeleting(p, p.spec.terminationGracePeriodSeconds ?? 30);
        engine.store.event({ type: 'Normal', reason: 'SuccessfulDelete', message: `Deleted pod: ${p.metadata.name}`, involved: job, component: 'job-controller' });
      }
    }
    const status: Job['status'] = { startTime: job.status.startTime };
    if (active.length) status.active = active.length;
    const ready = active.filter(isPodReady).length;
    status.ready = ready;
    if (succeeded.length) status.succeeded = succeeded.length;
    if (failed.length) status.failed = failed.length;
    (status as Record<string, unknown>).uncountedTerminatedPods = {};
    if (JSON.stringify(status) !== JSON.stringify(job.status)) {
      job.status = status;
      engine.store.update(job);
    }
  }
}

// --- CronJob ----------------------------------------------------------------

function parseField(f: string, min: number, max: number): Set<number> | 'any' {
  if (f === '*') return 'any';
  const out = new Set<number>();
  for (const part of f.split(',')) {
    const m = /^(\*|\d+)(?:-(\d+))?(?:\/(\d+))?$/.exec(part);
    if (!m) throw new Error(`invalid cron field "${f}"`);
    const step = m[3] ? parseInt(m[3], 10) : 1;
    let lo: number, hi: number;
    if (m[1] === '*') { lo = min; hi = max; }
    else { lo = parseInt(m[1] as string, 10); hi = m[2] ? parseInt(m[2], 10) : m[3] ? max : lo; }
    for (let i = lo; i <= hi; i += step) out.add(i);
  }
  return out;
}

export interface CronSpec { minute: Set<number> | 'any'; hour: Set<number> | 'any'; dom: Set<number> | 'any'; month: Set<number> | 'any'; dow: Set<number> | 'any' }

export function parseCron(s: string): CronSpec {
  const macros: Record<string, string> = { '@hourly': '0 * * * *', '@daily': '0 0 * * *', '@midnight': '0 0 * * *', '@weekly': '0 0 * * 0', '@monthly': '0 0 1 * *', '@yearly': '0 0 1 1 *', '@annually': '0 0 1 1 *' };
  const expr = macros[s.trim()] ?? s.trim();
  const f = expr.split(/\s+/);
  if (f.length !== 5) throw new Error(`expected exactly 5 fields, found ${f.length}: [${expr}]`);
  return { minute: parseField(f[0]!, 0, 59), hour: parseField(f[1]!, 0, 23), dom: parseField(f[2]!, 1, 31), month: parseField(f[3]!, 1, 12), dow: parseField(f[4]!, 0, 6) };
}

function cronMatches(c: CronSpec, d: Date): boolean {
  const ok = (s: Set<number> | 'any', v: number) => s === 'any' || s.has(v);
  return ok(c.minute, d.getUTCMinutes()) && ok(c.hour, d.getUTCHours()) && ok(c.dom, d.getUTCDate()) && ok(c.month, d.getUTCMonth() + 1) && ok(c.dow, d.getUTCDay());
}

/** Next scheduled time strictly after `afterMs`, up to 1 year ahead. */
export function nextCronTime(c: CronSpec, afterMs: number): number | undefined {
  let t = Math.floor(afterMs / 60000) * 60000 + 60000;
  for (let i = 0; i < 60 * 24 * 366; i++, t += 60000) if (cronMatches(c, new Date(t))) return t;
  return undefined;
}

export function runCronJobController(engine: Engine): void {
  const now = engine.clock.nowMs;
  for (const cj of engine.store.list<CronJob>('CronJob')) {
    if (cj.metadata.deletionTimestamp) continue;
    let spec: CronSpec;
    try { spec = parseCron(cj.spec.schedule); } catch { continue; }
    const jobs = engine.store.ownedBy<Job>(cj, 'Job');
    const active = jobs.filter((j) => !j.status.conditions?.some((c) => (c.type === 'Complete' || c.type === 'Failed') && c.status === 'True'));
    const last = cj.status.lastScheduleTime ? Date.parse(cj.status.lastScheduleTime) : Date.parse(cj.metadata.creationTimestamp ?? '') ;
    const due = nextCronTime(spec, last);
    let changed = false;
    if (!cj.spec.suspend && due !== undefined && due <= now) {
      const policy = cj.spec.concurrencyPolicy ?? 'Allow';
      let skip = false;
      if (policy === 'Forbid' && active.length) { skip = true; engine.store.event({ type: 'Normal', reason: 'JobAlreadyActive', message: `Not starting job because prior execution is running and concurrency policy is Forbid`, involved: cj, component: 'cronjob-controller' }); }
      if (policy === 'Replace') for (const j of active) engine.store.markDeleting(j, 0);
      const missed = cj.spec.startingDeadlineSeconds !== undefined && now - due > cj.spec.startingDeadlineSeconds * 1000;
      if (!skip && !missed) {
        const name = `${cj.metadata.name}-${Math.floor(due / 60000)}`;
        const job: Job = {
          apiVersion: 'batch/v1',
          kind: 'Job',
          metadata: { name, namespace: cj.metadata.namespace, labels: { ...(cj.spec.jobTemplate.metadata?.labels as Record<string, string> | undefined ?? {}) }, annotations: { 'batch.kubernetes.io/cronjob-scheduled-timestamp': engine.clock.iso(due) }, ownerReferences: [engine.store.ownerRef(cj)] },
          spec: structuredClone(cj.spec.jobTemplate.spec),
          status: {},
        };
        applyDefaults(job, engine);
        if (!engine.store.get('Job', cj.metadata.namespace, name)) {
          engine.store.create(job);
          engine.store.event({ type: 'Normal', reason: 'SuccessfulCreate', message: `Created job ${name}`, involved: cj, component: 'cronjob-controller' });
        }
      }
      cj.status.lastScheduleTime = engine.clock.iso(due);
      changed = true;
    }
    // history limits
    const finished = jobs.filter((j) => !active.includes(j)).sort((a, b) => (a.metadata.creationTimestamp! < b.metadata.creationTimestamp! ? -1 : 1));
    const ok = finished.filter((j) => j.status.conditions?.some((c) => c.type === 'Complete'));
    const bad = finished.filter((j) => j.status.conditions?.some((c) => c.type === 'Failed'));
    for (const j of ok.slice(0, Math.max(0, ok.length - (cj.spec.successfulJobsHistoryLimit ?? 3)))) engine.store.markDeleting(j, 0);
    for (const j of bad.slice(0, Math.max(0, bad.length - (cj.spec.failedJobsHistoryLimit ?? 1)))) engine.store.markDeleting(j, 0);
    const lastOk = ok.length ? ok[ok.length - 1]!.status.completionTime : undefined;
    if (lastOk && cj.status.lastSuccessfulTime !== lastOk) { cj.status.lastSuccessfulTime = lastOk; changed = true; }
    const activeRefs = active.map((j) => ({ apiVersion: 'batch/v1', kind: 'Job', name: j.metadata.name, namespace: j.metadata.namespace as string, uid: j.metadata.uid, resourceVersion: j.metadata.resourceVersion }));
    if (JSON.stringify(activeRefs.map((a) => a.name)) !== JSON.stringify((cj.status.active ?? []).map((a) => a.name))) {
      if (activeRefs.length) cj.status.active = activeRefs; else delete cj.status.active;
      changed = true;
    }
    if (changed) engine.store.update(cj);
  }
}
