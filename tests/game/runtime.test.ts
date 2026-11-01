import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MissionRuntime } from '../../src/game/runtime.ts';
import { m3_1 } from '../../src/missions/ch3.ts';
import type { ShellHost } from '../../src/engine/kubectl/context.ts';

const host: ShellHost = { sleep: async () => {}, backgroundSleep: async () => {}, editor: async () => null, readLine: async () => null, aborted: () => false };

test('pause freezes clock, traffic and timer; a fresh runtime restores the initial state', () => {
  const rt = new MissionRuntime(m3_1, host);
  rt.start();
  for (let i = 0; i < 20; i++) rt.tick(100);
  const t = rt.engine.clock.nowMs, elapsed = rt.elapsedMs, served = rt.engine.traffic.total.served;
  assert.ok(served > 0);
  rt.paused = true;
  for (let i = 0; i < 50; i++) rt.tick(100);
  assert.equal(rt.engine.clock.nowMs, t);
  assert.equal(rt.elapsedMs, elapsed);
  assert.equal(rt.engine.traffic.total.served, served);
  rt.paused = false;
  rt.tick(100);
  assert.equal(rt.engine.clock.nowMs, t + 100);
  // restart = a new runtime from the same mission: same initial pods, zero elapsed, empty history, deterministic
  const fresh = new MissionRuntime(m3_1, host);
  assert.equal(fresh.elapsedMs, 0);
  assert.equal(fresh.shell.history.length, 0);
  assert.equal(fresh.engine.traffic.total.served, 0);
  assert.deepEqual(fresh.engine.store.list('Pod', 'freight').map((p) => p.metadata.name), new MissionRuntime(m3_1, host).engine.store.list('Pod', 'freight').map((p) => p.metadata.name));
});
