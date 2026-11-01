/** How the (simulated) process inside a container answers network requests. Shared by probes, traffic and curl. */
import type { Engine } from './engine.ts';
import type { Pod } from './types.ts';
import type { ContainerRuntime } from './runtime.ts';
import { httpResponse } from './images.ts';

export type NetResult =
  | { ok: true; status: number; body: string }
  | { ok: false; error: 'refused' | 'timeout' | 'unreachable' };

export function isListening(rt: ContainerRuntime, now: number): boolean {
  if (rt.phase !== 'running' || rt.startedAt === undefined || !rt.behaviour) return false;
  return now >= rt.startedAt + rt.behaviour.startMs;
}

/** TCP connect to a container port. */
export function tcpConnect(rt: ContainerRuntime, port: number, now: number): NetResult {
  if (!isListening(rt, now)) return { ok: false, error: 'refused' };
  if (!rt.behaviour || !rt.behaviour.ports.includes(port)) return { ok: false, error: 'refused' };
  if (rt.hung) return { ok: false, error: 'timeout' };
  return { ok: true, status: 0, body: '' };
}

/** HTTP GET to a container port/path. */
export function httpGet(rt: ContainerRuntime, port: number, path: string, now: number): NetResult {
  const c = tcpConnect(rt, port, now);
  if (!c.ok) return c;
  const r = httpResponse(rt.behaviour!, path, now - (rt.startedAt as number));
  return { ok: true, status: r.status, body: r.body };
}

/** Find the container runtime that owns a port in a pod (first container listening on it). */
export function containerForPort(engine: Engine, pod: Pod, port: number): ContainerRuntime | undefined {
  const rt = engine.podRuntime(pod);
  for (const c of rt.containers) {
    const spec = pod.spec.containers.find((s) => s.name === c.name);
    const declared = spec?.ports?.some((p) => p.containerPort === port) ?? false;
    const listens = c.behaviour?.ports.includes(port) ?? false;
    if (declared || listens) return c;
  }
  return rt.containers[0];
}

/** HTTP request to a pod IP:port (as the kube-proxy / probe would do). */
export function requestPod(engine: Engine, pod: Pod, port: number, path: string): NetResult {
  if (!pod.status.podIP) return { ok: false, error: 'unreachable' };
  const nodeRt = engine.nodeRuntime(pod.spec.nodeName ?? '');
  if (!nodeRt.ready) return { ok: false, error: 'timeout' };
  const c = containerForPort(engine, pod, port);
  if (!c) return { ok: false, error: 'refused' };
  return httpGet(c, port, path, engine.clock.nowMs);
}
