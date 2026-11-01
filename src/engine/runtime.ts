/** Simulation-only state kept outside the API objects (never visible in -o yaml). */
import type { ResolvedBehaviour } from './images.ts';

export type ContainerPhase =
  | 'waiting' // created in pod, not started yet (waiting for image or backoff)
  | 'pulling'
  | 'pull-error'
  | 'pull-backoff'
  | 'config-error'
  | 'creating'
  | 'running'
  | 'terminated'
  | 'crash-backoff'
  | 'stopping';

export interface ProbeRuntime {
  successes: number;
  failures: number;
  nextAt: number;
  passed: boolean; // current result
}

export interface ContainerRuntime {
  name: string;
  image: string;
  behaviour: ResolvedBehaviour | undefined;
  phase: ContainerPhase;
  phaseSince: number;
  nextAt: number; // when the current phase transitions
  restartCount: number;
  backoffMs: number; // crash backoff currently applied (0 = none yet)
  pullBackoffMs: number;
  pullAttempts: number;
  startedAt?: number; // process start time (ms)
  runningSince?: number; // last time entering running
  stableSince?: number;
  ready: boolean;
  started: boolean; // startup probe passed (or none)
  hung: boolean;
  readiness?: ProbeRuntime;
  liveness?: ProbeRuntime;
  startup?: ProbeRuntime;
  env: Record<string, string>;
  logs: string[];
  prevLogs: string[];
  lastLoopLogAt: number;
  lastExit?: { code: number; reason: string; at: number; startedAt?: number };
  configError?: string;
  containerId?: string;
  memoryMiB: number;
  cpuMillis: number;
  /** Job attempt index for failUntilAttempt behaviour. */
  attempt: number;
  sigtermAt?: number;
}

export interface PodRuntime {
  uid: string;
  containers: ContainerRuntime[];
  scheduledAt?: number;
  terminating?: { since: number; deadline: number };
  /** Set by the node controller when the node is lost. */
  nodeLost?: boolean;
  evictAt?: number;
}

export interface NodeRuntime {
  name: string;
  ready: boolean;
  notReadySince?: number;
  imageCache: Set<string>;
  /** When the next status heartbeat is due (purely cosmetic). */
  lastHeartbeat: number;
}
