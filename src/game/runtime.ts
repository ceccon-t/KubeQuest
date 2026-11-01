/** MissionRuntime: owns the engine + shell for one mission attempt; evaluates objectives, fires chaos, scores. */
import { Engine } from '../engine/engine.ts';
import { Shell } from '../engine/shell.ts';
import { Vfs } from '../engine/vfs.ts';
import type { ShellHost } from '../engine/kubectl/context.ts';
import { setNodeReady } from '../engine/controllers/node.ts';
import { parseSelectorString, matches } from '../engine/selector.ts';
import { normalizeImage } from '../engine/images.ts';
import type { Pod, Deployment } from '../engine/types.ts';
import { ClusterView, type Mission, type ObjectiveContext, type ChaosEvent } from './mission.ts';
import { computeScore, type ScoreBreakdown } from './scoring.ts';

export type RuntimeEvent =
  | { type: 'objective'; id: string; text: string; insight?: string }
  | { type: 'objective-reverted'; id: string }
  | { type: 'chaos'; id: string; from: string; text: string }
  | { type: 'hint'; index: number; text: string }
  | { type: 'complete'; score: ScoreBreakdown; elapsedSec: number }
  | { type: 'sla-breached' };

export interface ObjectiveState { id: string; text: string; done: boolean; optional: boolean; visible: boolean }

export class MissionRuntime {
  readonly mission: Mission;
  readonly engine: Engine;
  readonly vfs: Vfs;
  readonly shell: Shell;
  readonly view: ClusterView;
  readonly flags = new Set<string>();
  elapsedMs = 0;
  started = false;
  completed = false;
  /** While paused nothing advances: no engine ticks, no traffic, no timer, no chaos. */
  paused = false;
  slaBreached = false;
  hintsUsed = 0;
  hintsCost = 0;
  private done = new Set<string>();
  private firedChaos = new Set<string>();
  private objectiveDoneAt = new Map<string, number>();
  private listeners: ((e: RuntimeEvent) => void)[] = [];
  private result: ScoreBreakdown | undefined;

  constructor(mission: Mission, host: ShellHost) {
    this.mission = mission;
    this.engine = new Engine(mission.cluster);
    this.engine.traffic.enabled = false;
    this.vfs = new Vfs(Object.fromEntries(Object.entries(mission.files ?? {}).map(([k, v]) => [k.startsWith('/') ? k : `/home/oncall/${k}`, v])));
    this.shell = new Shell(this.engine, this.vfs, host);
    this.view = new ClusterView(this.engine);
  }

  on(fn: (e: RuntimeEvent) => void): () => void {
    this.listeners.push(fn);
    return () => { this.listeners = this.listeners.filter((l) => l !== fn); };
  }
  private emit(e: RuntimeEvent): void {
    for (const l of this.listeners) l(e);
  }

  /** Called when the briefing closes: traffic and the clock start. */
  start(): void {
    this.started = true;
    this.engine.traffic.enabled = true;
  }

  get score(): ScoreBreakdown | undefined {
    return this.result;
  }

  objectives(): ObjectiveState[] {
    return this.mission.objectives.map((o) => ({ id: o.id, text: o.text, done: this.done.has(o.id), optional: !!o.optional, visible: !o.revealAfter || this.done.has(o.revealAfter) }));
  }

  /** Reveal the next hint; returns its text (or undefined when exhausted). */
  hint(): string | undefined {
    const h = this.mission.hints[this.hintsUsed];
    if (!h) return undefined;
    this.hintsUsed++;
    this.hintsCost += h.cost ?? 150;
    this.emit({ type: 'hint', index: this.hintsUsed, text: h.text });
    return h.text;
  }

  context(): ObjectiveContext {
    return { engine: this.engine, view: this.view, history: this.shell.history, elapsedSec: this.elapsedMs / 1000, slo: this.engine.traffic.stats(), flags: this.flags };
  }

  /** Advance the mission by real dt (ms). */
  tick(dtMs: number): void {
    if (!this.started || this.completed || this.paused) return;
    const dt = dtMs * (this.mission.cluster.timeScale ?? 1);
    this.engine.tick(dt);
    this.elapsedMs += dt;
    this.evaluate();
  }

  evaluate(): void {
    if (this.completed) return;
    const ctx = this.context();
    for (const o of this.mission.objectives) {
      if (o.revealAfter && !this.done.has(o.revealAfter)) continue;
      let ok = false;
      try { ok = o.check(ctx); } catch { ok = false; }
      if (ok && !this.done.has(o.id)) {
        this.done.add(o.id);
        this.objectiveDoneAt.set(o.id, this.elapsedMs);
        this.emit({ type: 'objective', id: o.id, text: o.text, insight: o.insight });
      }
    }
    for (const c of this.mission.chaos ?? []) {
      if (this.firedChaos.has(c.id)) continue;
      if (this.chaosDue(c)) {
        this.firedChaos.add(c.id);
        this.runChaos(c);
      }
    }
    if (this.mission.timeLimitSec && !this.slaBreached && this.elapsedMs / 1000 > this.mission.timeLimitSec) {
      this.slaBreached = true;
      this.emit({ type: 'sla-breached' });
    }
    if (this.mission.sandbox) return;
    const required = this.mission.objectives.filter((o) => !o.optional);
    if (required.every((o) => this.done.has(o.id)) && (this.mission.chaos ?? []).every((c) => this.firedChaos.has(c.id) || !('afterSeconds' in c.at) || c.at.afterSeconds > 1e9)) {
      this.complete();
    }
  }

  private chaosDue(c: ChaosEvent): boolean {
    if ('afterSeconds' in c.at) return this.elapsedMs >= c.at.afterSeconds * 1000;
    const at = this.objectiveDoneAt.get(c.at.afterObjective);
    if (at === undefined) return false;
    return this.elapsedMs >= at + (c.at.delaySeconds ?? 0) * 1000;
  }

  private runChaos(c: ChaosEvent): void {
    const a = c.action;
    const e = this.engine;
    switch (a.type) {
      case 'nodeDown': setNodeReady(e, a.node, false); break;
      case 'nodeUp': setNodeReady(e, a.node, true); break;
      case 'killPods': {
        const reqs = parseSelectorString(a.selector);
        const pods = e.store.list<Pod>('Pod', a.namespace).filter((p) => matches(reqs, p.metadata.labels) && !p.metadata.deletionTimestamp);
        for (const p of pods.slice(0, a.count ?? pods.length)) {
          e.store.event({ type: 'Warning', reason: 'NodeSysOOM', message: `System OOM encountered, victim process: ${p.spec.containers[0]?.name ?? 'app'}`, involved: p, component: 'kubelet', host: p.spec.nodeName });
          e.store.markDeleting(p, 0);
          e.store.remove(p);
          e.podRuntimes.delete(p.metadata.uid as string);
        }
        break;
      }
      case 'setImage': {
        const d = e.store.get<Deployment>('Deployment', a.namespace, a.deployment);
        if (d) {
          for (const ct of d.spec.template.spec.containers) if (!a.container || ct.name === a.container) ct.image = a.image;
          d.metadata.annotations = { ...(d.metadata.annotations ?? {}), 'kubernetes.io/change-cause': `ci-deploy ${normalizeImage(a.image).tag}` };
          e.store.update(d, { specChanged: true });
        }
        break;
      }
      case 'traffic': e.traffic.setRps(a.id, a.rps); break;
      case 'addImage': e.images.set(normalizeImage(a.image).full, a.behaviour); break;
      case 'flag': this.flags.add(a.flag); break;
      case 'custom': a.run(e); break;
    }
    if (c.announce) this.emit({ type: 'chaos', id: c.id, from: c.announce.from, text: c.announce.text });
  }

  private complete(): void {
    this.completed = true;
    const required = this.mission.objectives.filter((o) => !o.optional);
    const optional = this.mission.objectives.filter((o) => o.optional);
    const stats = this.engine.traffic.stats();
    const lifetime = stats.total.served + stats.total.failed + stats.total.dropped;
    const availability = lifetime ? stats.total.served / lifetime : 1;
    const hasTraffic = (this.mission.cluster.traffic ?? []).length > 0;
    const commands = this.shell.history.length;
    this.result = computeScore(this.mission, {
      objectivesDone: required.length,
      objectivesTotal: required.length,
      optionalDone: optional.filter((o) => this.done.has(o.id)).length,
      elapsedSec: this.elapsedMs / 1000,
      commands,
      hintsCost: this.hintsCost,
      availability,
      hasTraffic,
      sloMet: !this.mission.slo || availability >= this.mission.slo.minAvailability,
      slaBreached: this.slaBreached,
    });
    this.engine.traffic.enabled = false;
    this.emit({ type: 'complete', score: this.result, elapsedSec: this.elapsedMs / 1000 });
  }
}
