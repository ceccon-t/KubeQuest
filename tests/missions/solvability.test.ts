/** Every mission's scripted solution must complete the mission. This is the regression net for simulator + content. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MISSIONS } from '../../src/missions/index.ts';
import { MissionRuntime, type RuntimeEvent } from '../../src/game/runtime.ts';
import type { ShellHost } from '../../src/engine/kubectl/context.ts';
import type { SolutionStep } from '../../src/game/mission.ts';
import type { Endpoints } from '../../src/engine/types.ts';
import { m4_1 } from '../../src/missions/ch4.ts';

function runtimeHost(get: () => MissionRuntime): ShellHost & { editorQueue: ((s: string) => string | null)[]; abortFlag: boolean; waited: number } {
  const host = {
    editorQueue: [] as ((s: string) => string | null)[],
    abortFlag: false,
    waited: 0,
    async sleep(ms: number) {
      const rt = get();
      let left = ms;
      while (left > 0) { const step = Math.min(100, left); rt.tick(step); left -= step; }
      host.waited += ms;
      if (host.waited > 15 * 60_000) host.abortFlag = true;
    },
    async backgroundSleep() { await new Promise<void>((r) => setTimeout(r, 0)); },
    async editor(initial: string) { const f = host.editorQueue.shift(); return f ? f(initial) : null; },
    async readLine() { return null; },
    aborted() { return host.abortFlag; },
  };
  return host;
}

test('mission 4.1 requires replacing the stale selector and resuming reconciliation', async () => {
  const host = runtimeHost(() => rt);
  const rt = new MissionRuntime(m4_1, host);
  rt.start();
  const run = async (line: string) => {
    const gen = rt.shell.exec(line);
    let output = '';
    let result = await gen.next();
    while (!result.done) { output += result.value.text; result = await gen.next(); }
    assert.equal(result.value, 0, output);
    return output;
  };
  assert.equal(rt.view.endpointsReady('freight', 'cargo-api'), 0);
  await run('kubectl get endpoints cargo-api -n freight');
  await run('kubectl get svc cargo-api -n freight -o wide');
  await run('kubectl get pods -n freight --show-labels');

  // Reproduce the screenshot: adding the new key leaves an unsatisfied AND requirement.
  host.editorQueue.push((s) => s.replace('selector:\n    app: cargo-api', 'selector:\n    app: cargo-api\n    app.kubernetes.io/name: cargo-api'));
  await run('kubectl edit svc cargo-api -n freight');
  for (let i = 0; i < 20; i++) rt.tick(100);
  assert.deepEqual(rt.view.service('freight', 'cargo-api')?.spec.selector, {
    app: 'cargo-api', 'app.kubernetes.io/name': 'cargo-api',
  });
  assert.equal(rt.view.endpointsReady('freight', 'cargo-api'), 0);
  assert.equal(rt.completed, false);

  rt.paused = true;
  host.editorQueue.push((s) => s.replace('selector:\n    app: cargo-api\n', 'selector:\n'));
  await run('kubectl edit svc cargo-api -n freight');
  assert.deepEqual(rt.view.service('freight', 'cargo-api')?.spec.selector, { 'app.kubernetes.io/name': 'cargo-api' });
  for (let i = 0; i < 20; i++) rt.tick(100);
  assert.equal(rt.engine.store.get<Endpoints>('Endpoints', 'freight', 'cargo-api')?.subsets?.length ?? 0, 0);
  assert.equal(rt.completed, false);
  rt.paused = false;
  for (let i = 0; i < 20; i++) rt.tick(100);
  assert.equal(rt.view.endpointsReady('freight', 'cargo-api'), 2);
  assert.equal(rt.engine.store.get<Endpoints>('Endpoints', 'freight', 'cargo-api')?.subsets?.[0]?.addresses?.length, 2);
  assert.match(await run('kubectl exec tools -n freight -- curl -s cargo-api/healthz'), /ok/i);
  assert.equal(rt.completed, true);
});

for (const m of MISSIONS) {
  test(`mission ${m.id} "${m.title}" is solvable by its solution script`, async () => {
    let rt: MissionRuntime | undefined;
    const host = runtimeHost(() => rt as MissionRuntime);
    rt = new MissionRuntime(m, host);
    const events: RuntimeEvent[] = [];
    rt.on((e) => events.push(e));
    rt.start();
    const transcript: string[] = [];
    for (const step of m.solution as SolutionStep[]) {
      host.abortFlag = false;
      host.waited = 0;
      let line: string;
      if (typeof step === 'string') line = step;
      else {
        host.editorQueue.push((s) => s.replace(step.replace[0], step.replace[1]));
        line = step.edit.startsWith('__kubectl_edit__') ? `kubectl edit ${step.edit.slice('__kubectl_edit__ '.length)}` : `vim ${step.edit}`;
      }
      let output = '';
      const gen = rt.shell.exec(line);
      let r = await gen.next();
      while (!r.done) { output += r.value.text; r = await gen.next(); }
      transcript.push(`$ ${line}\n${output}`);
      // let controllers react between commands, as a human would pause
      for (let i = 0; i < 10; i++) rt.tick(100);
    }
    // settle
    for (let i = 0; i < 100 && !rt.completed; i++) rt.tick(100);
    const pending = rt.objectives().filter((o) => !o.done && !o.optional).map((o) => o.id);
    assert.ok(rt.completed, `mission ${m.id} not completed; pending objectives: ${pending.join(', ')}\n--- transcript ---\n${transcript.join('\n')}`);
    const score = rt.score!;
    assert.ok(score.stars >= 2, `solution should earn ≥2 stars, got ${score.stars} (${score.total}): ${score.notes.join('; ')}`);
  });
}
