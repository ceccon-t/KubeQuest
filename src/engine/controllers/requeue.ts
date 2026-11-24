/**
 * Retry pacing for controller syncs that fail (a Pod create refused by admission, for instance).
 * upstream: client-go workqueue.DefaultControllerRateLimiter — the key is requeued after 5ms·2^failures,
 * capped at 1000s; an update to the object itself is enqueued immediately, whatever the back-off.
 */
import type { Engine } from '../engine.ts';
import type { KubeObject } from '../types.ts';

interface Requeue { at: number; failures: number; generation: number }

const BASE_MS = 5;
const MAX_MS = 1_000_000;
const state = (engine: Engine, key: string): Requeue | undefined => engine.scratch.get(`requeue:${key}`) as Requeue | undefined;

/** True when the controller may attempt the failed operation again. */
export function syncDue(engine: Engine, key: string, obj: KubeObject): boolean {
  const s = state(engine, key);
  return !s || engine.clock.nowMs >= s.at || (obj.metadata.generation ?? 0) !== s.generation;
}

export function syncFailed(engine: Engine, key: string, obj: KubeObject): void {
  const failures = state(engine, key)?.failures ?? 0;
  const delay = Math.min(BASE_MS * 2 ** Math.min(failures, 30), MAX_MS);
  engine.scratch.set(`requeue:${key}`, { at: engine.clock.nowMs + delay, failures: failures + 1, generation: obj.metadata.generation ?? 0 });
}

export function syncSucceeded(engine: Engine, key: string): void {
  engine.scratch.delete(`requeue:${key}`);
}
