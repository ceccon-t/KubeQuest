/**
 * Kubelet simulation: image pulls, container start/crash/restart with backoff, probes,
 * OOM kills, graceful termination and pod status. Semantics follow pkg/kubelet.
 */
import type { Engine } from '../engine.ts';
import type { Pod, Container, ContainerStatus, Condition, Probe, Node, ConfigMap, Secret } from '../types.ts';
import type { ContainerRuntime, PodRuntime, ProbeRuntime } from '../runtime.ts';
import { lookupImage, normalizeImage, type ResolvedBehaviour } from '../images.ts';
import { parseMemoryBytes, parseCpuMillis } from '../duration.ts';
import { httpGet, tcpConnect, requestPod } from '../appsim.ts';
import { mountedFiles, containerFiles, writeContainerFile, isVolumePath, volumeId, releasePodVolumes } from '../containerfs.ts';
import { b64decode } from '../encoding.ts';
import { authorize, forbiddenMessage, serviceAccountUser } from '../rbac.ts';
import { resolveDns, serviceBackends, resolveTargetPort } from './service.ts';
import { podPeer, dnsAllowed } from '../netpol.ts';
import { execLine, splitScript } from '../container-shell.ts';
import { tokenize } from '../kubectl/args.ts';

export { mountedFiles };

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
    syncEphemeral(engine, pod, rt);
    if (!nodeRt.ready) continue; // kubelet unreachable; node controller handles

    if (pod.metadata.deletionTimestamp) {
      handleTermination(engine, pod, rt, now);
      continue;
    }
    if (pod.status.phase === 'Succeeded' || pod.status.phase === 'Failed') continue;

    let changed = false;
    // init containers run one after another; app containers start once all of them are done (sidecars: started)
    let gate = true;
    for (const c of rt.containers) {
      if (!c.ephemeral && !gate) continue;
      changed = stepContainer(engine, pod, rt, c, specOf(pod, c), now) || changed;
      if (c.init) gate = gate && initComplete(c);
    }
    const before = JSON.stringify(pod.status);
    computeStatus(engine, pod, rt, now);
    if (changed || JSON.stringify(pod.status) !== before) engine.store.update(pod);
  }
}

function newRuntime(engine: Engine, c: Container, extra: Partial<ContainerRuntime> = {}): ContainerRuntime {
  return {
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
    ...extra,
  };
}

function initRuntime(engine: Engine, pod: Pod, rt: PodRuntime): void {
  rt.containers = [
    ...(pod.spec.initContainers ?? []).map((c) => newRuntime(engine, c, { init: true, sidecar: (c as { restartPolicy?: string }).restartPolicy === 'Always' })),
    ...pod.spec.containers.map((c) => newRuntime(engine, c)),
  ];
  rt.scheduledAt = rt.scheduledAt ?? engine.clock.nowMs;
}

/** Ephemeral containers are added to a running pod (`kubectl debug`); give each a runtime when it shows up. */
function syncEphemeral(engine: Engine, pod: Pod, rt: PodRuntime): void {
  for (const c of pod.spec.ephemeralContainers ?? []) {
    if (!rt.containers.some((x) => x.ephemeral && x.name === c.name)) rt.containers.push(newRuntime(engine, c, { ephemeral: true }));
  }
}

/** The spec of a runtime container, whichever list it lives in. */
export function specOf(pod: Pod, c: ContainerRuntime): Container {
  const list = c.ephemeral ? pod.spec.ephemeralContainers : c.init ? pod.spec.initContainers : pod.spec.containers;
  return (list ?? []).find((s) => s.name === c.name) as Container;
}

function initComplete(c: ContainerRuntime): boolean {
  if (c.sidecar) return c.phase === 'running' && c.started;
  return c.phase === 'terminated' && c.nextAt === Infinity && (c.lastExit?.code ?? 1) === 0;
}

function appContainers(rt: PodRuntime): ContainerRuntime[] {
  return rt.containers.filter((c) => !c.init && !c.ephemeral);
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
      if (mountErr === 'wait') { c.nextAt = now + 500; return false; }
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
      const denied = c.behaviour ? pullAuthError(engine, pod, spec, c.behaviour) : undefined;
      if (denied) {
        c.pullError = denied;
        // kubelet strips the gRPC wrapper for code Unknown, so the containerd error is printed bare
        ev(engine, pod, 'Warning', 'Failed', `Failed to pull image "${spec.image}": ${denied}`);
        ev(engine, pod, 'Warning', 'Failed', 'Error: ErrImagePull');
        setPhase(c, 'pull-error', now, now + 1000);
        return true;
      }
      if (c.behaviour) {
        const took = ((now - c.phaseSince) / 1000).toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
        nodeRt.imageCache.add(img.full);
        ev(engine, pod, 'Normal', 'Pulled', `Successfully pulled image "${spec.image}" in ${took}s (${took}s including waiting). Image size: ${c.behaviour.sizeBytes} bytes.`);
        setPhase(c, 'creating', now, now + 200);
        return true;
      }
      // unknown image or tag
      c.pullError = `rpc error: code = NotFound desc = failed to pull and unpack image "${img.full}": failed to resolve reference "${img.full}": ${img.full}: not found`;
      const msg = `Failed to pull image "${spec.image}": ${c.pullError}`;
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
      const envErr = resolveEnv(engine, pod, spec, c) ?? nonRootError(pod, spec, c);
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
      if (c.script) changed = stepScript(engine, pod, c, spec, now) || changed;
      if (b.apiAccess) changed = checkApiAccess(engine, pod, c, b, now) || changed;
      if (b.stateful && now >= (c.startedAt as number) + b.startMs && now - (c.lastRecordAt ?? 0) >= (b.stateful.everyMs ?? 5000)) {
        c.lastRecordAt = now;
        c.records = (c.records ?? 0) + 1;
        writeContainerFile(engine, pod, spec, c, `${b.stateful.path.replace(/\/$/, '')}/${b.stateful.file}`, `${c.records}\n`);
      }
      if (now >= c.nextAt) {
        // the process exits
        exitProcess(engine, pod, rt, c, spec, now);
        return true;
      }
      if (c.ephemeral) { if (!c.ready) { c.ready = true; changed = true; } return changed; }
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
  // legacy apps write their log to a file instead of stdout: `kubectl logs` stays empty unless something tails that file
  if (c.behaviour?.logFile && c.fileLog) { c.fileLog(`${engine.clock.iso()} ${line}\n`); return; }
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
  c.fs = undefined; // a restarted container gets a fresh writable layer
  c.script = undefined;
  c.degraded = undefined;
  c.fileLog = undefined;
  if (b.logFile) {
    const file = b.logFile;
    pushLog(c, engine, `logging to ${file}`);
    c.fileLog = (text) => { writeContainerFile(engine, pod, spec, c, file, text, true); };
  }
  for (const l of b.logs?.start ?? []) pushLog(c, engine, l);
  if (b.stateful) {
    // a datastore: recover what is on disk, or start empty — only a volume survives the container
    const file = `${b.stateful.path.replace(/\/$/, '')}/${b.stateful.file}`;
    const found = containerFiles(engine, pod, spec, c).get(file);
    c.records = found !== undefined ? parseInt(found, 10) || 0 : 0;
    c.lastRecordAt = now;
    pushLog(c, engine, found !== undefined ? `recovered ${c.records} ${b.stateful.unit} from ${b.stateful.path}` : `no data found in ${b.stateful.path}: initializing an empty datastore (0 ${b.stateful.unit})`);
    if (found === undefined) writeContainerFile(engine, pod, spec, c, file, '0\n');
    if (!isVolumePath(engine, pod, spec, file)) pushLog(c, engine, `warning: ${b.stateful.path} is not a mounted volume; data will be lost when this container restarts`);
  }
  for (const e of b.echoEnv ?? []) pushLog(c, engine, `config: ${e}=${c.env[e] ?? '<unset>'}`);
  // Decide when/why the process will exit
  const missingEnv = (b.requiresEnv ?? []).filter((e) => !c.env[e]);
  const missingFiles = (b.requiresFiles ?? []).filter((f) => !containerFiles(engine, pod, spec, c).has(f));
  const roFs = spec.securityContext?.readOnlyRootFilesystem ? (b.writesTo ?? []).find((w) => !isVolumePath(engine, pod, spec, `${w.replace(/\/$/, '')}/x`)) : undefined;
  const dep = (b.requiresService ?? []).map((d) => dependencyError(engine, pod, d)).find((e) => e !== undefined);
  const argv = [...(spec.command ?? []), ...(spec.args ?? [])];
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
  } else if (roFs !== undefined) {
    pending.exitPlan = { code: 1, reason: 'Error', lines: [`fatal: open ${roFs.replace(/\/$/, '')}/.lock: read-only file system`] };
    c.nextAt = now + 300;
  } else if (dep !== undefined) {
    pending.exitPlan = { code: 1, reason: 'Error', lines: [`fatal: ${dep}`] };
    c.nextAt = now + 300;
  } else if (limitBytes !== undefined && limitBytes < b.memoryMiB * 1024 * 1024) {
    pending.exitPlan = { code: 137, reason: 'OOMKilled', lines: [] };
    c.nextAt = now + b.startMs + 1500;
  } else if (b.interpreter && (argv.length || spec.stdin || c.ephemeral)) {
    // busybox-style images run the given command; an interactive shell (stdin) just waits for input
    pending.exitPlan = undefined;
    if (argv.length) {
      const text = /^(\/bin\/)?(ba)?sh$/.test(argv[0] as string) ? (argv[1] === '-c' ? (argv[2] ?? '') : '') : argv.map((x) => (/[\s;&|<>]/.test(x) ? JSON.stringify(x) : x)).join(' ');
      if (text.trim()) c.script = { steps: splitScript(text), index: 0, resumeAt: now + b.startMs, code: 0 };
    }
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
  // init containers re-run only on failure; sidecars always restart; ephemeral containers never do
  const podPolicy = pod.spec.restartPolicy ?? 'Always';
  const policy = c.ephemeral ? 'Never' : c.sidecar ? 'Always' : c.init ? (podPolicy === 'Never' ? 'Never' : 'OnFailure') : podPolicy;
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
  const c = [...pod.spec.containers, ...(pod.spec.initContainers ?? [])].find((x) => x.name === containerName);
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
      for (const [k, v] of Object.entries(s.data ?? {})) env[k] = b64decode(v) ?? v;
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
      env[e.name] = b64decode(v) ?? v;
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

function checkVolumes(engine: Engine, pod: Pod): string | undefined {
  for (const v of pod.spec.volumes ?? []) {
    if (v.configMap && !v.configMap.optional) {
      if (!engine.store.get('ConfigMap', pod.metadata.namespace, v.configMap.name)) return `MountVolume.SetUp failed for volume "${v.name}" : configmap "${v.configMap.name}" not found`;
    }
    if (v.secret && !v.secret.optional) {
      if (!engine.store.get('Secret', pod.metadata.namespace, v.secret.secretName)) return `MountVolume.SetUp failed for volume "${v.name}" : secret "${v.secret.secretName}" not found`;
    }
    // a claim that is not bound yet (WaitForFirstConsumer provisioning in flight): the volume manager waits
    if (v.persistentVolumeClaim && volumeId(engine, pod, v) === undefined) return 'wait';
  }
  return undefined;
}

/** Registry authentication for private images: the pod (or its ServiceAccount) must reference a matching dockerconfigjson Secret. */
function pullAuthError(engine: Engine, pod: Pod, spec: Container, b: ResolvedBehaviour): string | undefined {
  if (!b.private) return undefined;
  const img = normalizeImage(spec.image);
  const host = img.full.split('/')[0] as string;
  const ns = pod.metadata.namespace as string;
  const sa = engine.store.get('ServiceAccount', ns, pod.spec.serviceAccountName ?? 'default');
  const refs = [...(pod.spec.imagePullSecrets ?? []), ...((sa?.imagePullSecrets as { name: string }[] | undefined) ?? [])];
  let sawCredentials = false;
  const missing: string[] = [];
  for (const ref of refs) {
    const secret = engine.store.get<Secret>('Secret', ns, ref.name);
    if (!secret) { missing.push(ref.name); continue; }
    if (secret.type !== 'kubernetes.io/dockerconfigjson') continue;
    let auths: Record<string, { username?: string; password?: string; auth?: string }> = {};
    try { auths = (JSON.parse(b64decode(secret.data?.['.dockerconfigjson'] ?? '') ?? '{}') as { auths?: typeof auths }).auths ?? {}; } catch { /* malformed config: no credentials */ }
    const entry = auths[host] ?? auths[`https://${host}`];
    if (!entry) continue;
    sawCredentials = true;
    const [u, pw] = entry.auth ? ((b64decode(entry.auth) ?? ':').split(':') as [string, string]) : [entry.username ?? '', entry.password ?? ''];
    if (u === b.private.username && pw === b.private.password) return undefined;
  }
  if (missing.length) engine.store.event({ type: 'Warning', reason: 'FailedToRetrieveImagePullSecret', message: `Unable to retrieve some image pull secrets (${missing.join(', ')}); attempting to pull the image may not succeed.`, involved: pod, component: 'kubelet', host: pod.spec.nodeName });
  const repo = img.full.slice(host.length + 1, img.full.lastIndexOf(':'));
  const scope = encodeURIComponent(`repository:${repo}:pull`);
  const how = sawCredentials ? 'failed to fetch oauth token' : 'failed to fetch anonymous token';
  return `failed to pull and unpack image "${img.full}": failed to resolve reference "${img.full}": failed to authorize: ${how}: unexpected status from GET request to https://${host}/token?scope=${scope}&service=${host}: 401 Unauthorized`;
}

/** upstream: pkg/kubelet/kuberuntime/security_context_others.go verifyRunAsNonRoot */
function nonRootError(pod: Pod, spec: Container, c: ContainerRuntime): string | undefined {
  const nonRoot = spec.securityContext?.runAsNonRoot ?? pod.spec.securityContext?.runAsNonRoot;
  if (!nonRoot) return undefined;
  const where = `(pod: "${pod.metadata.name}_${pod.metadata.namespace}(${pod.metadata.uid})", container: ${spec.name})`;
  const explicit = spec.securityContext?.runAsUser ?? pod.spec.securityContext?.runAsUser;
  if (explicit !== undefined) return explicit === 0 ? `container's runAsUser breaks non-root policy ${where}` : undefined;
  return (c.behaviour?.user ?? 0) === 0 ? `container has runAsNonRoot and image will run as root ${where}` : undefined;
}

/** A dependency the process dials at start (`name:port`): DNS, endpoints and NetworkPolicy must all let it through. */
function dependencyError(engine: Engine, pod: Pod, dep: string): string | undefined {
  const [name, portRaw] = dep.split(':') as [string, string | undefined];
  const port = parseInt(portRaw ?? '80', 10);
  if (!dnsAllowed(engine, pod)) return `dial tcp: lookup ${name} on 10.96.0.10:53: read udp ${pod.status.podIP ?? ''}:43122->10.96.0.10:53: i/o timeout`;
  const dns = resolveDns(engine, name, pod.metadata.namespace as string);
  if (!dns) return `dial tcp: lookup ${name} on 10.96.0.10:53: no such host`;
  const sp = dns.svc ? (dns.svc.spec.ports ?? []).find((p) => p.port === port) : undefined;
  const backend = dns.pod ?? (dns.svc ? serviceBackends(engine, dns.svc).ready[0] : undefined);
  if (!backend || (!dns.pod && !sp)) return `dial tcp ${dns.ip}:${port}: connect: connection refused`;
  const target = dns.pod || !dns.svc || !sp ? port : resolveTargetPort(dns.svc, sp, backend);
  const r = requestPod(engine, backend, target, '/', { from: podPeer(pod), fromPod: pod });
  if (!r.ok && r.error === 'timeout') return `dial tcp ${dns.ip}:${port}: i/o timeout`;
  if (!r.ok && r.error !== 'not-tls') return `dial tcp ${dns.ip}:${port}: connect: connection refused`;
  return undefined;
}

/** Processes that talk to the Kubernetes API (controllers, agents) fail their calls until RBAC allows them. */
function checkApiAccess(engine: Engine, pod: Pod, c: ContainerRuntime, b: ResolvedBehaviour, now: number): boolean {
  const ns = pod.metadata.namespace as string;
  const user = serviceAccountUser(ns, pod.spec.serviceAccountName ?? 'default');
  const deniedReq = (b.apiAccess ?? []).map((a) => ({ verb: a.verb, group: a.group ?? '', resource: a.resource, namespace: a.namespace === '' ? undefined : (a.namespace ?? ns) })).find((req) => !authorize(engine, user, req));
  if (deniedReq) {
    const msg = forbiddenMessage(user, deniedReq);
    const state = c as ContainerRuntime & { apiLogAt?: number };
    if (now - (state.apiLogAt ?? -Infinity) >= 10_000) { state.apiLogAt = now; pushLog(c, engine, `E reflector.go:158] "Unhandled Error" err="failed to ${deniedReq.verb} ${deniedReq.resource}: ${msg}"`); }
    if (c.degraded === undefined) { c.degraded = 'kubernetes api: forbidden'; return true; }
    return false;
  }
  if (c.degraded !== undefined) { c.degraded = undefined; pushLog(c, engine, 'I caches synced: kubernetes api access restored'); return true; }
  return false;
}

/** Run the command of a shell image (`sh -c "…"`, `sleep`, `tail -f`), one step at a time in game time. */
function stepScript(engine: Engine, pod: Pod, c: ContainerRuntime, spec: Container, now: number): boolean {
  const sc = c.script;
  if (!sc || sc.blocked || now < sc.resumeAt) { if (sc?.blocked) tailFollow(engine, pod, c, spec); return false; }
  const state = c as ContainerRuntime & { exitPlan?: { code: number; reason: string; lines: string[] } };
  const emit = (text: string): void => { for (const l of text.split('\n')) if (l !== '') pushLog(c, engine, l); };
  const run = (line: string): number => { const r = execLine(engine, pod, c.name, line); emit(r.chunks.map((x) => x.text).join('')); return r.code; };
  let budget = 50;
  while (sc.index < sc.steps.length && budget-- > 0) {
    let step = (sc.steps[sc.index] as string).trim();
    const onlyIfOk = step.startsWith('&&');
    if (onlyIfOk) { step = step.slice(2).trim(); if (sc.code !== 0) { sc.index++; continue; } }
    step = step.replace(/^exec\s+/, '');
    let m: RegExpExecArray | null;
    if ((m = /^sleep\s+(\S+)$/.exec(step))) {
      sc.index++;
      sc.code = 0;
      if (m[1] === 'infinity' || m[1] === 'inf') { sc.blocked = true; return false; }
      sc.resumeAt = now + parseFloat(m[1] as string) * 1000;
      return false;
    }
    if (/^tail\s+.*-[fF]/.test(step) || /^(sh|bash|ash)$/.test(step)) { sc.blocked = true; (c as ContainerRuntime & { tail?: { file: string; offset: number; warned: boolean } }).tail = step.startsWith('tail') ? { file: (tokenize(step) ?? []).filter((t) => !t.startsWith('-') && !/^\+?\d+$/.test(t)).pop() ?? '', offset: 0, warned: false } : undefined; tailFollow(engine, pod, c, spec); return true; }
    if ((m = /^(until|while)\s+([\s\S]*?);\s*do\s+([\s\S]*?);?\s*done$/.exec(step))) {
      const cond = (m[2] as string).trim();
      const ok = cond === 'true' || cond === ':' ? true : run(cond) === 0;
      if ((m[1] === 'until') === ok) { sc.index++; sc.code = 0; continue; }
      // loop body: run it, honour its sleep, come back to the condition
      let pause = 1000;
      for (const b of splitScript(m[3] as string)) { const sl = /^sleep\s+([\d.]+)$/.exec(b.replace(/^&&\s*/, '').trim()); if (sl) pause = parseFloat(sl[1] as string) * 1000; else run(b.replace(/^&&\s*/, '')); }
      sc.resumeAt = now + pause;
      return true;
    }
    sc.code = run(step);
    sc.index++;
  }
  if (sc.index >= sc.steps.length) {
    state.exitPlan = { code: sc.code, reason: sc.code === 0 ? 'Completed' : 'Error', lines: [] };
    c.nextAt = now + 100;
    sc.blocked = true; // finished: nothing left to step, the process exits at nextAt
  }
  return true;
}

/** `tail -f FILE`: mirror what is appended to the file into the container's stdout. */
function tailFollow(engine: Engine, pod: Pod, c: ContainerRuntime, spec: Container): void {
  const t = (c as ContainerRuntime & { tail?: { file: string; offset: number; warned: boolean } }).tail;
  if (!t) return;
  const text = containerFiles(engine, pod, spec, c).get(t.file);
  if (text === undefined) { if (!t.warned) { t.warned = true; pushLog(c, engine, `tail: can't open '${t.file}': No such file or directory`); pushLog(c, engine, 'tail: no files'); } return; }
  if (text.length < t.offset) t.offset = 0;
  const fresh = text.slice(t.offset);
  t.offset = text.length;
  for (const l of fresh.split('\n')) if (l !== '') { c.logs.push(/^\d{4}-\d{2}-\d{2}T/.test(l) ? l : `${engine.clock.iso()} ${l}`); }
  if (c.logs.length > MAX_LOG_LINES) c.logs.splice(0, c.logs.length - MAX_LOG_LINES);
}

// ---------------------------------------------------------------------------
// Termination
// ---------------------------------------------------------------------------

function handleTermination(engine: Engine, pod: Pod, rt: PodRuntime, now: number): void {
  const deadline = Date.parse(pod.metadata.deletionTimestamp as string);
  if (!rt.terminating) {
    rt.terminating = { since: now, deadline };
    for (const c of rt.containers) {
      const spec = specOf(pod, c);
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
    releasePodVolumes(engine, pod);
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
    imageID: c.behaviour ? `${img.full.split(':')[0]}@sha256:${c.behaviour.digest ?? fakeDigest(img.full)}` : '',
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
      st.state = { waiting: { reason: 'ErrImagePull', message: c.pullError ?? '' } };
      break;
    case 'pull-backoff':
      st.state = { waiting: { reason: 'ImagePullBackOff', message: `Back-off pulling image "${spec.image}": ErrImagePull: ${c.pullError ?? ''}` } };
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
  const inits = rt.containers.filter((c) => c.init);
  const apps = appContainers(rt);
  const ephemerals = rt.containers.filter((c) => c.ephemeral);
  const initialized = inits.every(initComplete);
  const statusOf = (c: ContainerRuntime): ContainerStatus => {
    const st = containerStatus(c, specOf(pod, c), engine);
    // containers held back by init containers report PodInitializing, not ContainerCreating
    if (!initialized && !c.ephemeral && c.phase === 'waiting' && c.startedAt === undefined && st.state.waiting?.reason === 'ContainerCreating') st.state = { waiting: { reason: 'PodInitializing' } };
    return st;
  };
  status.containerStatuses = apps.map(statusOf);
  if (inits.length) status.initContainerStatuses = inits.map(statusOf);
  if (ephemerals.length) status.ephemeralContainerStatuses = ephemerals.map(statusOf);
  const anyStarted = apps.some((c) => c.startedAt !== undefined);
  const allTerminated = apps.every((c) => c.phase === 'terminated' && c.nextAt === Infinity);
  const anyRunning = apps.some((c) => c.phase === 'running' || c.phase === 'stopping');
  const initFailed = inits.some((c) => !c.sidecar && c.phase === 'terminated' && c.nextAt === Infinity && (c.lastExit?.code ?? 0) !== 0);
  let phase: Pod['status']['phase'];
  if (initFailed) phase = 'Failed';
  else if (allTerminated && apps.length) {
    phase = apps.every((c) => (c.lastExit?.code ?? 0) === 0) ? 'Succeeded' : 'Failed';
  } else if (anyRunning || anyStarted) phase = 'Running';
  else phase = 'Pending';
  if (phase === 'Running' && apps.every((c) => c.phase === 'terminated' || c.phase === 'crash-backoff') && (pod.spec.restartPolicy ?? 'Always') !== 'Always' && apps.every((c) => c.phase === 'terminated')) phase = 'Failed';
  status.phase = phase;
  const gating = [...apps, ...inits.filter((c) => c.sidecar)];
  const allReady = gating.length > 0 && gating.every((c) => c.ready);
  const t = engine.clock.iso();
  const cond = (type: string, ok: boolean, reason?: string, message?: string): Condition => {
    const prev = status.conditions?.find((c) => c.type === type);
    const s = ok ? 'True' : 'False';
    const out: Condition = { type, status: s, lastProbeTime: null, lastTransitionTime: prev && prev.status === s ? prev.lastTransitionTime : t };
    if (!ok && reason) { out.reason = reason; out.message = message; }
    return out;
  };
  const notReadyNames = gating.filter((c) => !c.ready).map((c) => c.name);
  const crNotReady = `containers with unready status: [${notReadyNames.join(' ')}]`;
  const final = phase === 'Succeeded' || phase === 'Failed';
  status.conditions = [
    cond('PodReadyToStartContainers', !!status.podIP),
    cond('Initialized', initialized, 'ContainersNotInitialized', `containers with incomplete status: [${inits.filter((c) => !initComplete(c)).map((c) => c.name).join(' ')}]`),
    cond('Ready', allReady && !pod.metadata.deletionTimestamp, final ? 'PodCompleted' : 'ContainersNotReady', final ? undefined : crNotReady),
    cond('ContainersReady', allReady && !pod.metadata.deletionTimestamp, final ? 'PodCompleted' : 'ContainersNotReady', final ? undefined : crNotReady),
    cond('PodScheduled', true),
  ];
  if (pod.metadata.deletionTimestamp) {
    // kubelet marks the pod not ready while terminating
    for (const c of status.conditions) if (c.type === 'Ready' || c.type === 'ContainersReady') { c.status = 'False'; c.reason = 'ContainersNotReady'; c.message = crNotReady; }
  }
}

/** Resource usage of a running pod (for `kubectl top` and the HPA): idle cost plus what the current request load burns. */
export function podUsage(engine: Engine, pod: Pod): { cpuMillis: number; memoryBytes: number } {
  const rt = engine.podRuntime(pod);
  const rate = engine.traffic.podRate(pod.metadata.uid as string);
  let cpu = 0, mem = 0;
  for (const c of rt.containers) {
    if (c.phase !== 'running') continue;
    const spec = specOf(pod, c) as Container | undefined;
    const lim = spec?.resources?.limits?.cpu !== undefined ? parseCpuMillis(spec.resources.limits.cpu) : Infinity;
    const load = c.init || c.ephemeral ? 0 : rate * (c.behaviour?.cpuPerRequestMillis ?? 0);
    cpu += Math.min(Math.round(c.cpuMillis + load), lim);
    mem += c.memoryMiB * 1024 * 1024;
  }
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
