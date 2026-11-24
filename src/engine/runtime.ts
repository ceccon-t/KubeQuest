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
  /** Init container (runs to completion before the app containers start); `sidecar` = restartPolicy Always. */
  init?: boolean;
  sidecar?: boolean;
  /** Ephemeral debug container (`kubectl debug`). */
  ephemeral?: boolean;
  /** Last image pull error (shown in the waiting state while backing off). */
  pullError?: string;
  /** Sink for apps that log to a file (`logFile` behaviour). */
  fileLog?: (text: string) => void;
  /** The container's own writable layer (absolute path → content); gone when the container restarts. */
  fs?: Map<string, string>;
  /** Shell images started with a command run it as a small script (init containers, sidecars, debug pods). */
  script?: { steps: string[]; index: number; resumeAt: number; code: number; blocked?: boolean };
  /** Record counter of a `stateful` datastore image. */
  records?: number;
  lastRecordAt?: number;
  /** When set the process is up but answers 503 with this text (e.g. it cannot reach the Kubernetes API). */
  degraded?: string;
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
