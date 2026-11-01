/**
 * Kubelet simulation: image pulls, container start/crash/restart with backoff, probes,
 * OOM kills, graceful termination and pod status. Semantics follow pkg/kubelet.
 */
import type { Engine } from '../engine.ts';
import type { Pod, Container, ContainerStatus, Condition, Probe, Node, ConfigMap, Secret } from '../types.ts';
import type { ContainerRuntime, PodRuntime, ProbeRuntime } from '../runtime.ts';
import { lookupImage, normalizeImage, type ResolvedBehaviour } from '../images.ts';
import { parseMemoryBytes, parseCpuMillis } from '../duration.ts';
import { httpGet, tcpConnect } from '../appsim.ts';

const MAX_BACKOFF_MS = 300_000;
const BACKOFF_RESET_MS = 600_000; // container ran ≥10 min ⇒ backoff resets
const MAX_LOG_LINES = 400;

function fakeDigest(s: string): string {
  let h1 = 0x12345678, h2 = 0x9abcdef0;
  for (let i = 0; i < s.length; i++) {
    h1 = Math.imul(h1 ^ s.charCodeAt(i), 0x01000193) >>> 0;
    h2 = Math.imul(h2 + s.charCodeAt(i), 0x85ebca6b) >>> 0;
  }
  const hex = (h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')).repeat(4);
  return hex.slice(0, 64);
}

function ev(engine: Engine, pod: Pod, type: 'Normal' | 'Warning', reason: string, message: string, fieldPath?: string): void {
  engine.store.event({ type, reason, message, involved: fieldPath ? { kind: 'Pod', name: pod.metadata.name, namespace: pod.metadata.namespace, uid: pod.metadata.uid } : pod, component: 'kubelet', host: pod.spec.nodeName });
}

export function runKubelet(engine: Engine, _dtMs: number): void {
  const now = engine.clock.nowMs;
  for (const pod of engine.store.list<Pod>('Pod')) {
    if (!pod.spec.nodeName) continue;
    const nodeRt = engine.nodeRuntime(pod.spec.nodeName);
    const rt = engine.podRuntime(pod);
    if (rt.containers.length === 0) initRuntime(engine, pod, rt);
    if (!nodeRt.ready) continue; // kubelet unreachable; node controller handles

    if (pod.metadata.deletionTimestamp) {
      handleTermination(engine, pod, rt, now);
      continue;
    }
    if (pod.status.phase === 'Succeeded' || pod.status.phase === 'Failed') continue;

    let changed = false;
    for (const c of rt.containers) {
      const spec = pod.spec.containers.find((s) => s.name === c.name) as Container;
      changed = stepContainer(engine, pod, rt, c, spec, now) || changed;
    }
    const before = JSON.stringify(pod.status);
    computeStatus(engine, pod, rt, now);
    if (changed || JSON.stringify(pod.status) !== before) engine.store.update(pod);
  }
}

function initRuntime(engine: Engine, pod: Pod, rt: PodRuntime): void {
  rt.containers = pod.spec.containers.map((c) => ({
    name: c.name,
    image: c.image,
    behaviour: lookupImage(engine.images, c.image),
    phase: 'waiting',
    phaseSince: engine.clock.nowMs,
    nextAt: engine.clock.nowMs,
    restartCount: 0,
    backoffMs: 0,
    pullBackoffMs: 0,
    pullAttempts: 0,
    ready: false,
    started: false,
    hung: false,
    env: {},
    logs: [],
    prevLogs: [],
    lastLoopLogAt: 0,
    memoryMiB: 0,
    cpuMillis: 0,
    attempt: 0,
  }));
  rt.scheduledAt = rt.scheduledAt ?? engine.clock.nowMs;
}

// ---------------------------------------------------------------------------
// Container state machine
// ---------------------------------------------------------------------------

function stepContainer(engine: Engine, pod: Pod, rt: PodRuntime, c: ContainerRuntime, spec: Container, now: number): boolean {
  const nodeRt = engine.nodeRuntime(pod.spec.nodeName as string);
  const img = normalizeImage(spec.image);
  switch (c.phase) {
    case 'waiting': {
      if (now < c.nextAt) return false;
      // sandbox / pod IP
      if (!pod.status.podIP) {
        pod.status.podIP = engine.allocatePodIp(pod.spec.nodeName as string);
        pod.status.podIPs = [{ ip: pod.status.podIP }];
      }
      // volumes referencing ConfigMaps/Secrets must exist before containers start
      const mountErr = checkVolumes(engine, pod);
      if (mountErr) {
        ev(engine, pod, 'Warning', 'FailedMount', mountErr);
        c.nextAt = now + 10_000;
        return true;
      }
      const policy = spec.imagePullPolicy ?? (img.tag === 'latest' ? 'Always' : 'IfNotPresent');
      const cached = nodeRt.imageCache.has(img.full);
      if (policy === 'Never' && !cached) {
        c.phase = 'config-error';
        c.configError = 'ErrImageNeverPull';
        ev(engine, pod, 'Warning', 'ErrImageNeverPull', `Container image "${spec.image}" is not present with pull policy of Never`);
        c.nextAt = now + 10_000;
        return true;
      }
      if (cached && policy === 'IfNotPresent') {
        ev(engine, pod, 'Normal', 'Pulled', `Container image "${spec.image}" already present on machine`);
        setPhase(c, 'creating', now, now + 150);
        return true;
      }
      ev(engine, pod, 'Normal', 'Pulling', `Pulling image "${spec.image}"`);
      const pullMs = c.behaviour ? (cached ? Math.max(300, c.behaviour.pullMs / 6) : c.behaviour.pullMs) : 1200;
      c.pullAttempts++;
      setPhase(c, 'pulling', now, now + pullMs);
      return true;
    }
    case 'pulling': {
      if (now < c.nextAt) return false;
      if (c.behaviour) {
        const took = ((now - c.phaseSince) / 1000).toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
        nodeRt.imageCache.add(img.full);
        ev(engine, pod, 'Normal', 'Pulled', `Successfully pulled image "${spec.image}" in ${took}s (${took}s including waiting). Image size: ${c.behaviour.sizeBytes} bytes.`);
        setPhase(c, 'creating', now, now + 200);
        return true;
      }
      // unknown image or tag
      const msg = `Failed to pull image "${spec.image}": rpc error: code = NotFound desc = failed to pull and unpack image "${img.full}": failed to resolve reference "${img.full}": ${img.full}: not found`;
      ev(engine, pod, 'Warning', 'Failed', msg);
      ev(engine, pod, 'Warning', 'Failed', 'Error: ErrImagePull');
      setPhase(c, 'pull-error', now, now + 1000);
      return true;
    }
    case 'pull-error': {
      if (now < c.nextAt) return false;
      c.pullBackoffMs = c.pullBackoffMs === 0 ? 10_000 : Math.min(c.pullBackoffMs * 2, MAX_BACKOFF_MS);
      ev(engine, pod, 'Normal', 'BackOff', `Back-off pulling image "${spec.image}"`);
      ev(engine, pod, 'Warning', 'Failed', 'Error: ImagePullBackOff');
      setPhase(c, 'pull-backoff', now, now + c.pullBackoffMs);
      return true;
    }
    case 'pull-backoff': {
      if (now < c.nextAt) return false;
      // maybe the image was pushed / the spec changed meanwhile
      c.behaviour = lookupImage(engine.images, spec.image);
      c.image = spec.image;
      setPhase(c, 'waiting', now, now);
      return true;
    }
    case 'config-error': {
      if (now < c.nextAt) return false;
      setPhase(c, 'waiting', now, now);
      return true;
    }
    case 'creating': {
      if (now < c.nextAt) return false;
      const envErr = resolveEnv(engine, pod, spec, c);
      if (envErr) {
        c.phase = 'config-error';
        c.configError = envErr;
        ev(engine, pod, 'Warning', 'Failed', `Error: ${envErr}`);
        c.nextAt = now + 10_000;
        return true;
      }
      c.configError = undefined;
      ev(engine, pod, 'Normal', 'Created', `Created container ${spec.name}`);
      ev(engine, pod, 'Normal', 'Started', `Started container ${spec.name}`);
      startProcess(engine, pod, c, spec, now);
      return true;
    }
    case 'running': {
      let changed = false;
      const b = c.behaviour as ResolvedBehaviour;
      // periodic logs
      if (b.logs?.loop && b.logs.loop.length && now - c.lastLoopLogAt >= (b.logs.loopEveryMs ?? 5000) && now >= (c.startedAt as number) + b.startMs) {
        c.lastLoopLogAt = now;
        const line = b.logs.loop[Math.floor((now / (b.logs.loopEveryMs ?? 5000)) % b.logs.loop.length)] as string;
        pushLog(c, engine, line);
      }
      if (b.hangAfterMs !== undefined && !c.hung && now >= (c.startedAt as number) + b.startMs + b.hangAfterMs) {
        c.hung = true;
        pushLog(c, engine, 'warn: worker pool exhausted; requests are queueing');
        changed = true;
      }
      if (now >= c.nextAt) {
        // the process exits
        exitProcess(engine, pod, rt, c, spec, now);
        return true;
      }
      changed = runProbes(engine, pod, c, spec, now) || changed;
      return changed;
    }
    case 'terminated': {
      if (now < c.nextAt) return false;
      if (c.nextAt === Infinity) return false;
      // move into crash backoff (restart policy allows restart)
      c.backoffMs = c.backoffMs === 0 ? 10_000 : Math.min(c.backoffMs * 2, MAX_BACKOFF_MS);
      ev(engine, pod, 'Warning', 'BackOff', `Back-off restarting failed container ${spec.name} in pod ${pod.metadata.name}_${pod.metadata.namespace}(${pod.metadata.uid})`);
      setPhase(c, 'crash-backoff', now, now + c.backoffMs);
      return true;
    }
    case 'crash-backoff': {
      if (now < c.nextAt) return false;
      c.restartCount++;
      c.attempt++;
      ev(engine, pod, 'Normal', 'Pulled', `Container image "${spec.image}" already present on machine`);
      setPhase(c, 'creating', now, now + 150);
      return true;
    }
    case 'stopping':
      return false;
  }
}

function setPhase(c: ContainerRuntime, phase: ContainerRuntime['phase'], now: number, nextAt: number): void {
  c.phase = phase;
  c.phaseSince = now;
  c.nextAt = nextAt;
}

function pushLog(c: ContainerRuntime, engine: Engine, line: string): void {
  c.logs.push(`${engine.clock.iso()} ${line}`);
  if (c.logs.length > MAX_LOG_LINES) c.logs.splice(0, c.logs.length - MAX_LOG_LINES);
}

function startProcess(engine: Engine, pod: Pod, c: ContainerRuntime, spec: Container, now: number): void {
  const b = c.behaviour as ResolvedBehaviour;
  c.phase = 'running';
  c.phaseSince = now;
  c.startedAt = now;
  c.runningSince = now;
  c.hung = false;
  c.logs = [];
  c.lastLoopLogAt = now;
  c.containerId = `containerd://${fakeDigest(`${pod.metadata.uid}/${spec.name}/${c.restartCount}`)}`;
  c.ready = false;
  c.started = !spec.startupProbe;
  c.memoryMiB = b.memoryMiB;
  c.cpuMillis = b.cpuMillis;
  c.readiness = spec.readinessProbe ? newProbe(spec.readinessProbe, now) : undefined;
  c.liveness = spec.livenessProbe ? newProbe(spec.livenessProbe, now) : undefined;
  c.startup = spec.startupProbe ? newProbe(spec.startupProbe, now) : undefined;
  for (const l of b.logs?.start ?? []) pushLog(c, engine, l);
  for (const e of b.echoEnv ?? []) pushLog(c, engine, `config: ${e}=${c.env[e] ?? '<unset>'}`);
  // Decide when/why the process will exit
  const missingEnv = (b.requiresEnv ?? []).filter((e) => !c.env[e]);
  const missingFiles = (b.requiresFiles ?? []).filter((f) => !mountedFiles(engine, pod, spec).has(f));
  const limitBytes = spec.resources?.limits?.memory !== undefined ? parseMemoryBytes(spec.resources.limits.memory) : undefined;
  c.nextAt = Infinity;
  c.lastExit = undefined;
  const pending = c as ContainerRuntime & { exitPlan?: { code: number; reason: string; lines: string[] } };
  if (missingEnv.length) {
    pending.exitPlan = { code: 1, reason: 'Error', lines: [`fatal: required environment variable ${missingEnv[0]} is not set`, 'exiting with status 1'] };
    c.nextAt = now + 300;
  } else if (missingFiles.length) {
    pending.exitPlan = { code: 1, reason: 'Error', lines: [`fatal: open ${missingFiles[0]}: no such file or directory`] };
    c.nextAt = now + 300;
  } else if (limitBytes !== undefined && limitBytes < b.memoryMiB * 1024 * 1024) {
    pending.exitPlan = { code: 137, reason: 'OOMKilled', lines: [] };
    c.nextAt = now + b.startMs + 1500;
  } else if (b.runToCompletion) {
    const fail = b.runToCompletion.failUntilAttempt !== undefined && c.attempt < b.runToCompletion.failUntilAttempt;
    const code = fail ? 1 : (b.runToCompletion.exitCode ?? 0);
    pending.exitPlan = { code, reason: code === 0 ? 'Completed' : 'Error', lines: fail ? (b.logs?.onCrash ?? ['error: task failed']) : [] };
    c.nextAt = now + b.runToCompletion.durationMs;
  } else if (b.crashAfterMs !== undefined) {
    pending.exitPlan = { code: b.crashExitCode, reason: 'Error', lines: b.logs?.onCrash ?? ['panic: unexpected error', 'goroutine 1 [running]:', 'main.main()'] };
    c.nextAt = now + b.startMs + b.crashAfterMs;
  } else {
    pending.exitPlan = undefined;
  }
}

function exitProcess(engine: Engine, pod: Pod, _rt: PodRuntime, c: ContainerRuntime, spec: Container, now: number): void {
  const plan = (c as ContainerRuntime & { exitPlan?: { code: number; reason: string; lines: string[] } }).exitPlan ?? { code: 0, reason: 'Completed', lines: [] };
  for (const l of plan.lines) pushLog(c, engine, l);
  c.prevLogs = c.logs;
  c.logs = [];
  c.lastExit = { code: plan.code, reason: plan.reason, at: now, startedAt: c.startedAt };
  c.ready = false;
  const ranMs = now - (c.startedAt ?? now);
  const policy = pod.spec.restartPolicy ?? 'Always';
  const willRestart = policy === 'Always' || (policy === 'OnFailure' && plan.code !== 0);
  if (ranMs >= BACKOFF_RESET_MS) c.backoffMs = 0;
  if (!willRestart) {
    setPhase(c, 'terminated', now, Infinity);
    return;
  }
  // brief "Error"/"Completed" window before CrashLoopBackOff is reported
  setPhase(c, 'terminated', now, now + 1500);
}

function newProbe(p: Probe, now: number): ProbeRuntime {
  return { successes: 0, failures: 0, nextAt: now + (p.initialDelaySeconds ?? 0) * 1000, passed: false };
}

function runProbes(engine: Engine, pod: Pod, c: ContainerRuntime, spec: Container, now: number): boolean {
  let changed = false;
  const kill = (kind: string, msg: string): void => {
    ev(engine, pod, 'Normal', 'Killing', `Container ${spec.name} failed ${kind} probe, will be restarted`);
    void msg;
    const plan = c as ContainerRuntime & { exitPlan?: { code: number; reason: string; lines: string[] } };
    plan.exitPlan = { code: 137, reason: 'Error', lines: [] };
    c.nextAt = now; // exits on next step
  };
  if (c.startup && spec.startupProbe && !c.started) {
    if (now >= c.startup.nextAt) {
      c.startup.nextAt = now + (spec.startupProbe.periodSeconds ?? 10) * 1000;
      const r = probe(c, spec.startupProbe, pod, now);
      if (r.ok) {
        c.startup.successes++;
        if (c.startup.successes >= (spec.startupProbe.successThreshold ?? 1)) { c.started = true; changed = true; }
      } else {
        c.startup.failures++;
        c.startup.successes = 0;
        ev(engine, pod, 'Warning', 'Unhealthy', `Startup probe failed: ${r.message}`);
        if (c.startup.failures >= (spec.startupProbe.failureThreshold ?? 3)) { kill('startup', r.message); return true; }
      }
    }
    if (!c.started) {
      if (c.ready) { c.ready = false; changed = true; }
      return changed;
    }
  }
  if (c.readiness && spec.readinessProbe) {
    if (now >= c.readiness.nextAt) {
      c.readiness.nextAt = now + (spec.readinessProbe.periodSeconds ?? 10) * 1000;
      const r = probe(c, spec.readinessProbe, pod, now);
      if (r.ok) {
        c.readiness.successes++;
        c.readiness.failures = 0;
        if (!c.ready && c.readiness.successes >= (spec.readinessProbe.successThreshold ?? 1)) { c.ready = true; changed = true; }
      } else {
        c.readiness.failures++;
        c.readiness.successes = 0;
        ev(engine, pod, 'Warning', 'Unhealthy', `Readiness probe failed: ${r.message}`);
        if (c.ready && c.readiness.failures >= (spec.readinessProbe.failureThreshold ?? 3)) { c.ready = false; changed = true; }
      }
    }
  } else if (!c.ready) {
    // no readiness probe: ready as soon as the container is running
    c.ready = true;
    changed = true;
  }
  if (c.liveness && spec.livenessProbe) {
    if (now >= c.liveness.nextAt) {
      c.liveness.nextAt = now + (spec.livenessProbe.periodSeconds ?? 10) * 1000;
      const r = probe(c, spec.livenessProbe, pod, now);
      if (r.ok) {
        c.liveness.failures = 0;
      } else {
        c.liveness.failures++;
        ev(engine, pod, 'Warning', 'Unhealthy', `Liveness probe failed: ${r.message}`);
        if (c.liveness.failures >= (spec.livenessProbe.failureThreshold ?? 3)) { kill('liveness', r.message); return true; }
      }
    }
  }
  return changed;
}

function probe(c: ContainerRuntime, p: Probe, pod: Pod, now: number): { ok: boolean; message: string } {
  const ip = pod.status.podIP ?? '0.0.0.0';
  if (p.httpGet) {
    const port = resolvePort(p.httpGet.port, pod, c.name);
    const path = p.httpGet.path ?? '/';
    const r = httpGet(c, port, path, now);
    const url = `http://${ip}:${port}${path}`;
    if (!r.ok) {
      if (r.error === 'timeout') return { ok: false, message: `Get "${url}": context deadline exceeded (Client.Timeout exceeded while awaiting headers)` };
      return { ok: false, message: `Get "${url}": dial tcp ${ip}:${port}: connect: connection refused` };
    }
    if (r.status >= 200 && r.status < 400) return { ok: true, message: '' };
    return { ok: false, message: `HTTP probe failed with statuscode: ${r.status}` };
  }
  if (p.tcpSocket) {
    const port = resolvePort(p.tcpSocket.port, pod, c.name);
    const r = tcpConnect(c, port, now);
    if (r.ok) return { ok: true, message: '' };
    return { ok: false, message: `dial tcp ${ip}:${port}: connect: connection refused` };
  }
  if (p.exec) {
    const listening = c.phase === 'running' && now >= (c.startedAt ?? 0) + (c.behaviour?.startMs ?? 0);
    const cmd = p.exec.command.join(' ');
    const fails = (c.behaviour?.execProbeFails as string[] | undefined)?.some((f) => cmd.includes(f)) ?? false;
    if (listening && !fails && !c.hung) return { ok: true, message: '' };
    return { ok: false, message: `command "${cmd}" timed out` };
  }
  return { ok: true, message: '' };
}

function resolvePort(port: number | string, pod: Pod, containerName: string): number {
  if (typeof port === 'number') return port;
  if (/^\d+$/.test(port)) return parseInt(port, 10);
  const c = pod.spec.containers.find((x) => x.name === containerName);
  const named = c?.ports?.find((p) => p.name === port);
  return named?.containerPort ?? 0;
}

// ---------------------------------------------------------------------------
// Env / volumes
// ---------------------------------------------------------------------------

function resolveEnv(engine: Engine, pod: Pod, spec: Container, c: ContainerRuntime): string | undefined {
  const env: Record<string, string> = {
    PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    HOSTNAME: pod.metadata.name,
    KUBERNETES_SERVICE_HOST: '10.96.0.1',
    KUBERNETES_SERVICE_PORT: '443',
    KUBERNETES_PORT: 'tcp://10.96.0.1:443',
  };
  const ns = pod.metadata.namespace as string;
  for (const ef of spec.envFrom ?? []) {
    if (ef.configMapRef) {
      const cm = engine.store.get<ConfigMap>('ConfigMap', ns, ef.configMapRef.name);
      if (!cm) {
        if (ef.configMapRef.optional) continue;
        return `configmap "${ef.configMapRef.name}" not found`;
      }
      for (const [k, v] of Object.entries(cm.data ?? {})) env[k] = v;
    }
    if (ef.secretRef) {
      const s = engine.store.get<Secret>('Secret', ns, ef.secretRef.name);
      if (!s) {
        if (ef.secretRef.optional) continue;
        return `secret "${ef.secretRef.name}" not found`;
      }
      for (const [k, v] of Object.entries(s.data ?? {})) env[k] = b64decode(v);
    }
  }
  for (const e of spec.env ?? []) {
    if (e.value !== undefined) { env[e.name] = expand(e.value, env); continue; }
    const vf = e.valueFrom;
    if (!vf) { env[e.name] = ''; continue; }
    if (vf.configMapKeyRef) {
      const cm = engine.store.get<ConfigMap>('ConfigMap', ns, vf.configMapKeyRef.name);
      if (!cm) {
        if (vf.configMapKeyRef.optional) continue;
        return `configmap "${vf.configMapKeyRef.name}" not found`;
      }
      const v = cm.data?.[vf.configMapKeyRef.key];
      if (v === undefined) {
        if (vf.configMapKeyRef.optional) continue;
        return `couldn't find key ${vf.configMapKeyRef.key} in ConfigMap ${ns}/${vf.configMapKeyRef.name}`;
      }
      env[e.name] = v;
    } else if (vf.secretKeyRef) {
      const s = engine.store.get<Secret>('Secret', ns, vf.secretKeyRef.name);
      if (!s) {
        if (vf.secretKeyRef.optional) continue;
        return `secret "${vf.secretKeyRef.name}" not found`;
      }
      const v = s.data?.[vf.secretKeyRef.key];
      if (v === undefined) {
        if (vf.secretKeyRef.optional) continue;
        return `couldn't find key ${vf.secretKeyRef.key} in Secret ${ns}/${vf.secretKeyRef.name}`;
      }
      env[e.name] = b64decode(v);
    } else if (vf.fieldRef) {
      const fp = vf.fieldRef.fieldPath;
      env[e.name] = fp === 'metadata.name' ? pod.metadata.name : fp === 'metadata.namespace' ? ns : fp === 'status.podIP' ? (pod.status.podIP ?? '') : fp === 'spec.nodeName' ? (pod.spec.nodeName ?? '') : fp === 'status.hostIP' ? (pod.status.hostIP ?? '') : '';
    }
  }
  c.env = env;
  return undefined;
}

function expand(v: string, env: Record<string, string>): string {
  return v.replace(/\$\(([A-Za-z_][A-Za-z0-9_]*)\)/g, (m, k: string) => env[k] ?? m);
}

function b64decode(s: string): string {
  try {
    return typeof atob === 'function' ? atob(s) : Buffer.from(s, 'base64').toString('utf8');
  } catch {
    return s;
  }
}

function checkVolumes(engine: Engine, pod: Pod): string | undefined {
  for (const v of pod.spec.volumes ?? []) {
    if (v.configMap && !v.configMap.optional) {
      if (!engine.store.get('ConfigMap', pod.metadata.namespace, v.configMap.name)) return `MountVolume.SetUp failed for volume "${v.name}" : configmap "${v.configMap.name}" not found`;
    }
    if (v.secret && !v.secret.optional) {
      if (!engine.store.get('Secret', pod.metadata.namespace, v.secret.secretName)) return `MountVolume.SetUp failed for volume "${v.name}" : secret "${v.secret.secretName}" not found`;
    }
  }
  return undefined;
}

/** Absolute paths of files visible to a container through its volume mounts. */
export function mountedFiles(engine: Engine, pod: Pod, spec: Container): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of spec.volumeMounts ?? []) {
    const v = pod.spec.volumes?.find((x) => x.name === m.name);
    if (!v) continue;
    let data: Record<string, string> = {};
    if (v.configMap) data = engine.store.get<ConfigMap>('ConfigMap', pod.metadata.namespace, v.configMap.name)?.data ?? {};
    if (v.secret) {
      const s = engine.store.get<Secret>('Secret', pod.metadata.namespace, v.secret.secretName)?.data ?? {};
      for (const [k, val] of Object.entries(s)) data[k] = b64decode(val);
    }
    const items = v.configMap?.items ?? v.secret?.items;
    if (m.subPath) {
      if (data[m.subPath] !== undefined) out.set(m.mountPath, data[m.subPath] as string);
      continue;
    }
    for (const [k, val] of Object.entries(data)) {
      const p = items ? items.find((i) => i.key === k)?.path : k;
      if (!p) continue;
      out.set(`${m.mountPath.replace(/\/$/, '')}/${p}`, val);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Termination
// ---------------------------------------------------------------------------

function handleTermination(engine: Engine, pod: Pod, rt: PodRuntime, now: number): void {
  const deadline = Date.parse(pod.metadata.deletionTimestamp as string);
  if (!rt.terminating) {
    rt.terminating = { since: now, deadline };
    for (const c of rt.containers) {
      const spec = pod.spec.containers.find((s) => s.name === c.name) as Container;
      if (c.phase === 'running') {
        ev(engine, pod, 'Normal', 'Killing', `Stopping container ${spec.name}`);
        for (const l of c.behaviour?.logs?.onStop ?? []) pushLog(c, engine, l);
        const grace = c.behaviour?.sigtermGraceMs ?? 600;
        c.ready = false;
        c.sigtermAt = now;
        setPhase(c, 'stopping', now, Math.min(now + grace, deadline));
      } else if (c.phase !== 'terminated') {
        setPhase(c, 'terminated', now, Infinity);
        c.lastExit = { code: 137, reason: 'Error', at: now, startedAt: c.startedAt };
      }
    }
  } else {
    for (const c of rt.containers) {
      if (c.phase === 'stopping' && now >= c.nextAt) {
        const killed = now >= deadline && (c.behaviour?.sigtermGraceMs ?? 0) > deadline - (c.sigtermAt ?? now);
        c.lastExit = { code: killed ? 137 : 0, reason: killed ? 'Error' : 'Completed', at: now, startedAt: c.startedAt };
        c.prevLogs = c.logs;
        setPhase(c, 'terminated', now, Infinity);
      }
    }
  }
  computeStatus(engine, pod, rt, now);
  const allDone = rt.containers.every((c) => c.phase === 'terminated');
  if (allDone) {
    engine.store.remove(pod);
    engine.podRuntimes.delete(pod.metadata.uid as string);
  } else engine.store.update(pod);
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

function containerStatus(c: ContainerRuntime, spec: Container, engine: Engine): ContainerStatus {
  const img = normalizeImage(spec.image);
  const st: ContainerStatus = {
    name: c.name,
    image: spec.image.includes('/') ? spec.image : `docker.io/library/${spec.image}${spec.image.includes(':') ? '' : ':latest'}`,
    imageID: c.behaviour ? `${img.full.split(':')[0]}@sha256:${fakeDigest(img.full)}` : '',
    ready: c.ready,
    started: c.phase === 'running',
    restartCount: c.restartCount,
    state: {},
    lastState: {},
  };
  if (c.containerId) st.containerID = c.containerId;
  const iso = (ms: number) => engine.clock.iso(ms);
  switch (c.phase) {
    case 'waiting':
    case 'pulling':
    case 'creating':
      st.state = { waiting: { reason: 'ContainerCreating' } };
      break;
    case 'pull-error':
      st.state = { waiting: { reason: 'ErrImagePull', message: `rpc error: code = NotFound desc = failed to pull and unpack image "${img.full}": failed to resolve reference "${img.full}": ${img.full}: not found` } };
      break;
    case 'pull-backoff':
      st.state = { waiting: { reason: 'ImagePullBackOff', message: `Back-off pulling image "${spec.image}"` } };
      break;
    case 'config-error':
      st.state = { waiting: { reason: c.configError === 'ErrImageNeverPull' ? 'ErrImageNeverPull' : 'CreateContainerConfigError', message: c.configError } };
      break;
    case 'running':
    case 'stopping':
      st.state = { running: { startedAt: iso(c.startedAt as number) } };
      break;
    case 'terminated':
      st.state = { terminated: { exitCode: c.lastExit?.code ?? 0, reason: c.lastExit?.reason ?? 'Completed', startedAt: c.lastExit?.startedAt !== undefined ? iso(c.lastExit.startedAt) : undefined, finishedAt: iso(c.lastExit?.at ?? engine.clock.nowMs), containerID: c.containerId } };
      break;
    case 'crash-backoff':
      st.state = { waiting: { reason: 'CrashLoopBackOff', message: `back-off ${humanBackoff(c.backoffMs)} restarting failed container=${c.name} pod=${c.name}` } };
      break;
  }
  if (c.lastExit && c.phase !== 'terminated') {
    st.lastState = { terminated: { exitCode: c.lastExit.code, reason: c.lastExit.reason, startedAt: c.lastExit.startedAt !== undefined ? iso(c.lastExit.startedAt) : undefined, finishedAt: iso(c.lastExit.at), containerID: c.containerId } };
  }
  return st;
}

function humanBackoff(ms: number): string {
  const s = ms / 1000;
  return s >= 60 ? `${Math.floor(s / 60)}m${s % 60 ? (s % 60) + 's' : ''}` : `${s}s`;
}

export function computeStatus(engine: Engine, pod: Pod, rt: PodRuntime, now: number): void {
  const node = engine.store.get<Node>('Node', undefined, pod.spec.nodeName as string);
  const status = pod.status;
  status.hostIP = node?.status.addresses.find((a) => a.type === 'InternalIP')?.address;
  if (status.hostIP) (status as Record<string, unknown>).hostIPs = [{ ip: status.hostIP }];
  status.startTime = status.startTime ?? engine.clock.iso(rt.scheduledAt ?? now);
  status.containerStatuses = rt.containers.map((c) => containerStatus(c, pod.spec.containers.find((s) => s.name === c.name) as Container, engine));
  const anyStarted = rt.containers.some((c) => c.startedAt !== undefined);
  const allTerminated = rt.containers.every((c) => c.phase === 'terminated' && c.nextAt === Infinity);
  const anyRunning = rt.containers.some((c) => c.phase === 'running' || c.phase === 'stopping');
  let phase: Pod['status']['phase'];
  if (allTerminated && rt.containers.length) {
    phase = rt.containers.every((c) => (c.lastExit?.code ?? 0) === 0) ? 'Succeeded' : 'Failed';
  } else if (anyRunning || anyStarted) phase = 'Running';
  else phase = 'Pending';
  if (phase === 'Running' && rt.containers.every((c) => c.phase === 'terminated' || c.phase === 'crash-backoff') && (pod.spec.restartPolicy ?? 'Always') !== 'Always' && rt.containers.every((c) => c.phase === 'terminated')) phase = 'Failed';
  status.phase = phase;
  const allReady = rt.containers.length > 0 && rt.containers.every((c) => c.ready);
  const t = engine.clock.iso();
  const cond = (type: string, ok: boolean, reason?: string, message?: string): Condition => {
    const prev = status.conditions?.find((c) => c.type === type);
    const s = ok ? 'True' : 'False';
    const out: Condition = { type, status: s, lastProbeTime: null, lastTransitionTime: prev && prev.status === s ? prev.lastTransitionTime : t };
    if (!ok && reason) { out.reason = reason; out.message = message; }
    return out;
  };
  const notReadyNames = rt.containers.filter((c) => !c.ready).map((c) => c.name);
  const crNotReady = `containers with unready status: [${notReadyNames.join(' ')}]`;
  const final = phase === 'Succeeded' || phase === 'Failed';
  status.conditions = [
    cond('PodReadyToStartContainers', !!status.podIP),
    cond('Initialized', true),
    cond('Ready', allReady && !pod.metadata.deletionTimestamp, final ? 'PodCompleted' : 'ContainersNotReady', final ? undefined : crNotReady),
    cond('ContainersReady', allReady && !pod.metadata.deletionTimestamp, final ? 'PodCompleted' : 'ContainersNotReady', final ? undefined : crNotReady),
    cond('PodScheduled', true),
  ];
  if (pod.metadata.deletionTimestamp) {
    // kubelet marks the pod not ready while terminating
    for (const c of status.conditions) if (c.type === 'Ready' || c.type === 'ContainersReady') { c.status = 'False'; c.reason = 'ContainersNotReady'; c.message = crNotReady; }
  }
}

/** Resource usage of a running pod (for `kubectl top`). */
export function podUsage(engine: Engine, pod: Pod): { cpuMillis: number; memoryBytes: number } {
  const rt = engine.podRuntime(pod);
  let cpu = 0, mem = 0;
  for (const c of rt.containers) {
    if (c.phase !== 'running') continue;
    const spec = pod.spec.containers.find((s) => s.name === c.name);
    const lim = spec?.resources?.limits?.cpu !== undefined ? parseCpuMillis(spec.resources.limits.cpu) : Infinity;
    cpu += Math.min(c.cpuMillis, lim);
    mem += c.memoryMiB * 1024 * 1024;
  }
  void engine;
  return { cpuMillis: cpu, memoryBytes: mem };
}

export function isPodReady(pod: Pod): boolean {
  return pod.status.conditions?.some((c) => c.type === 'Ready' && c.status === 'True') ?? false;
}

/** Pod is "available" when ready for at least minReadySeconds (upstream: IsPodAvailable). */
export function isPodAvailable(pod: Pod, minReadySeconds: number, nowMs: number): boolean {
  const c = pod.status.conditions?.find((x) => x.type === 'Ready');
  if (!c || c.status !== 'True') return false;
  if (minReadySeconds === 0) return true;
  const since = c.lastTransitionTime ? Date.parse(c.lastTransitionTime) : nowMs;
  return nowMs - since >= minReadySeconds * 1000;
}
