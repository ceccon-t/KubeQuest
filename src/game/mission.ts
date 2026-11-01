/** Mission DSL: what a ticket is made of. Missions are data modules under src/missions. */
import type { Engine, ClusterSetup } from '../engine/engine.ts';
import type { ContainerBehaviour } from '../engine/images.ts';
import type { ExecRecord } from '../engine/shell.ts';
import type { SloStats } from '../engine/traffic.ts';
import type { KubeObject, Pod, Deployment, Service, Node, Endpoints } from '../engine/types.ts';
import { parseSelectorString, matches } from '../engine/selector.ts';
import { isPodReady } from '../engine/controllers/kubelet.ts';
import { serviceBackends } from '../engine/controllers/service.ts';

export interface ConceptCard {
  title: string;
  /** Short markdown-lite body (paragraphs separated by blank lines; `code` spans). ≤120 words. */
  body: string;
  example?: string;
}

export interface Objective {
  id: string;
  text: string;
  check: (ctx: ObjectiveContext) => boolean;
  /** Optional objectives give bonus score but are not required to finish. */
  optional?: boolean;
  /** Revealed only once the named objective is complete (keeps surprises). */
  revealAfter?: string;
  /** Senior-engineer commentary unlocked when the objective completes (guides attention, no answers). */
  insight?: string;
}

export interface Hint {
  text: string;
  /** Score penalty (default 150). */
  cost?: number;
}

export type ChaosAction =
  | { type: 'nodeDown'; node: string }
  | { type: 'nodeUp'; node: string }
  | { type: 'killPods'; namespace: string; selector: string; count?: number }
  | { type: 'setImage'; namespace: string; deployment: string; container?: string; image: string }
  | { type: 'traffic'; id: string; rps: number }
  | { type: 'addImage'; image: string; behaviour: ContainerBehaviour }
  | { type: 'flag'; flag: string }
  | { type: 'custom'; run: (engine: Engine) => void };

export interface ChaosEvent {
  id: string;
  at: { afterSeconds: number } | { afterObjective: string; delaySeconds?: number };
  action: ChaosAction;
  /** Pager message shown to the player when it fires. */
  announce?: { from: string; text: string };
}

export interface Mission {
  id: string;
  chapter: number;
  order: number;
  title: string;
  tagline: string;
  /** Tutorial missions have no stakes and are ≤3 minutes. */
  tutorial?: boolean;
  /** Sandbox: free play, never completes. */
  sandbox?: boolean;
  ticket: { from: string; priority: 'P1' | 'P2' | 'P3' | 'P4'; subject: string; body: string[] };
  /** Briefing lesson: ≤5 short paragraphs tying the concepts to this ticket (AGENTS.md §5). */
  lesson?: string[];
  concepts: ConceptCard[];
  cluster: ClusterSetup;
  /** VFS seed, relative to ~ (the player's workstation). */
  files?: Record<string, string>;
  objectives: Objective[];
  chaos?: ChaosEvent[];
  hints: Hint[];
  par: { timeSec: number; commands: number };
  /** SLA: exceeding it caps the stars at 1. */
  timeLimitSec?: number;
  /** Traffic missions: 3 stars require this lifetime availability. */
  slo?: { minAvailability: number };
  /** Scripted steps that solve the mission (used by tests): a shell line, or an editor transform. */
  solution: SolutionStep[];
  debrief: { proTips: string[] };
}

export type SolutionStep = string | { edit: string; replace: [string | RegExp, string] };

export interface ObjectiveContext {
  engine: Engine;
  view: ClusterView;
  history: ExecRecord[];
  elapsedSec: number;
  slo: SloStats;
  flags: Set<string>;
}

/** Read-only, typed queries over the cluster for objectives and the UI. */
export class ClusterView {
  engine: Engine;
  constructor(engine: Engine) {
    this.engine = engine;
  }
  pods(ns?: string, selector?: string): Pod[] {
    const reqs = selector ? parseSelectorString(selector) : [];
    return this.engine.store.list<Pod>('Pod', ns).filter((p) => !p.metadata.deletionTimestamp && matches(reqs, p.metadata.labels));
  }
  pod(ns: string, name: string): Pod | undefined {
    return this.engine.store.get<Pod>('Pod', ns, name);
  }
  readyPods(ns?: string, selector?: string): Pod[] {
    return this.pods(ns, selector).filter(isPodReady);
  }
  deployment(ns: string, name: string): Deployment | undefined {
    return this.engine.store.get<Deployment>('Deployment', ns, name);
  }
  deploymentReady(ns: string, name: string, replicas?: number): boolean {
    const d = this.deployment(ns, name);
    if (!d) return false;
    const want = replicas ?? d.spec.replicas ?? 1;
    return (d.spec.replicas ?? 1) === want && (d.status.availableReplicas ?? 0) === want && (d.status.updatedReplicas ?? 0) === want && (d.status.replicas ?? 0) === want;
  }
  deploymentImage(ns: string, name: string, container?: string): string | undefined {
    const d = this.deployment(ns, name);
    const c = d?.spec.template.spec.containers.find((x) => !container || x.name === container);
    return c?.image;
  }
  service(ns: string, name: string): Service | undefined {
    return this.engine.store.get<Service>('Service', ns, name);
  }
  endpointsReady(ns: string, svc: string): number {
    const s = this.service(ns, svc);
    if (!s) return 0;
    return serviceBackends(this.engine, s).ready.length;
  }
  endpoints(ns: string, name: string): Endpoints | undefined {
    return this.engine.store.get<Endpoints>('Endpoints', ns, name);
  }
  node(name: string): Node | undefined {
    return this.engine.store.get<Node>('Node', undefined, name);
  }
  get<T extends KubeObject = KubeObject>(kind: string, ns: string | undefined, name: string): T | undefined {
    return this.engine.store.get<T>(kind, ns, name);
  }
  list<T extends KubeObject = KubeObject>(kind: string, ns?: string): T[] {
    return this.engine.store.list<T>(kind, ns);
  }
}

/** Whether a successful command matching the regex was run. */
export function ran(history: ExecRecord[], re: RegExp, opts: { success?: boolean } = { success: true }): boolean {
  return history.some((h) => re.test(h.line) && (!opts.success || h.code === 0));
}

/** Whether a successful command printed output matching the regex. */
export function saw(history: ExecRecord[], re: RegExp): boolean {
  return history.some((h) => h.code === 0 && re.test(h.stdout));
}
