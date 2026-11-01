/**
 * Image catalogue: every image the simulator knows, with the behaviour of the process inside.
 * Missions can extend the catalogue. Unknown image/tag ⇒ ErrImagePull / ImagePullBackOff.
 */

export interface HttpResponse {
  status: number;
  body: string;
  /** Until this many ms after process start the path answers 503 (warm-up). */
  warmupMs?: number;
}

export interface LogScript {
  /** Lines printed at process start (relative offsets in ms, default spaced 100ms). */
  start?: string[];
  /** Lines repeated forever while running. */
  loop?: string[];
  loopEveryMs?: number;
  /** Lines printed just before a crash. */
  onCrash?: string[];
  /** Lines printed when SIGTERM is received. */
  onStop?: string[];
}

export interface ContainerBehaviour {
  /** Time to pull on a node that has not cached the image. */
  pullMs?: number;
  /** Compressed size reported in the "Successfully pulled" event. */
  sizeBytes?: number;
  /** Time from "Started" until the process listens / passes probes. */
  startMs?: number;
  /** Extra warm-up after start before readiness endpoints return 200. */
  readyAfterMs?: number;
  /** Ports the process listens on. */
  ports?: number[];
  cpuMillis?: number;
  memoryMiB?: number;
  /** The process exits 1 at startup unless these env vars are set. */
  requiresEnv?: string[];
  /** The process exits 1 at startup unless these files exist (volume mounts). */
  requiresFiles?: string[];
  /** The process crashes after running this long (deterministic bug). */
  crashAfterMs?: number;
  /** Exit code used for crashes. Default 1. */
  crashExitCode?: number;
  /** After this many ms the process deadlocks: HTTP stops answering (liveness lesson). */
  hangAfterMs?: number;
  /** Time the process takes to exit on SIGTERM; Infinity = ignores SIGTERM (waits for SIGKILL at grace end). */
  sigtermGraceMs?: number;
  /** Canned HTTP responses by path. Missing path ⇒ 404. */
  http?: Record<string, HttpResponse>;
  logs?: LogScript;
  /** Files visible from `kubectl exec ... cat`. */
  files?: Record<string, string>;
  /** Run-to-completion process (Jobs): exits after durationMs with exitCode. */
  runToCompletion?: { durationMs: number; exitCode?: number; failUntilAttempt?: number };
  /** Whether the image contains a shell (`kubectl exec -it ... sh`). */
  hasShell?: boolean;
  /** Which env var names the process prints in its start logs (teaching aid). */
  echoEnv?: string[];
  /** Human description shown by the game's `help images`. */
  description?: string;
  /** Hidden message in logs that explains a failure (missions rely on it). */
  [extra: string]: unknown;
}

export type ImageCatalog = Map<string, ContainerBehaviour>;

const DEFAULTS: Required<Pick<ContainerBehaviour, 'pullMs' | 'sizeBytes' | 'startMs' | 'readyAfterMs' | 'ports' | 'cpuMillis' | 'memoryMiB' | 'sigtermGraceMs' | 'hasShell' | 'crashExitCode'>> = {
  pullMs: 2500,
  sizeBytes: 38_000_000,
  startMs: 800,
  readyAfterMs: 0,
  ports: [8080],
  cpuMillis: 20,
  memoryMiB: 48,
  sigtermGraceMs: 600,
  hasShell: true,
  crashExitCode: 1,
};

export type ResolvedBehaviour = ContainerBehaviour & typeof DEFAULTS;

/** Normalise an image reference: add `docker.io/library/` for bare names and `:latest` for untagged. */
export function normalizeImage(ref: string): { full: string; repo: string; tag: string; display: string } {
  let repo = ref;
  let tag = 'latest';
  const at = ref.indexOf('@');
  if (at >= 0) {
    repo = ref.slice(0, at);
    tag = ref.slice(at + 1);
  } else {
    const lastSlash = ref.lastIndexOf('/');
    const colon = ref.lastIndexOf(':');
    if (colon > lastSlash) {
      repo = ref.slice(0, colon);
      tag = ref.slice(colon + 1);
    }
  }
  let full = repo;
  if (!repo.includes('/')) full = `docker.io/library/${repo}`;
  else if (!/^[^/]+\.[^/]+\//.test(repo) && !repo.startsWith('localhost')) full = `docker.io/${repo}`;
  return { full: `${full}:${tag}`, repo, tag, display: ref };
}

export function lookupImage(catalog: ImageCatalog, ref: string): ResolvedBehaviour | undefined {
  const n = normalizeImage(ref);
  const b = catalog.get(n.full) ?? catalog.get(`${n.repo}:${n.tag}`);
  if (!b) return undefined;
  return { ...DEFAULTS, ...b };
}

export function catalogHasRepo(catalog: ImageCatalog, ref: string): boolean {
  const n = normalizeImage(ref);
  for (const key of catalog.keys()) if (key.startsWith(n.full.slice(0, n.full.lastIndexOf(':') + 1))) return true;
  return false;
}

/** Build a catalogue from a plain record (helper for missions). */
export function makeCatalog(entries: Record<string, ContainerBehaviour>): ImageCatalog {
  const m: ImageCatalog = new Map();
  for (const [k, v] of Object.entries(entries)) m.set(normalizeImage(k).full, v);
  return m;
}

/** Images every mission can rely on. */
export function baseCatalog(): ImageCatalog {
  return makeCatalog({
    'nginx:1.27': {
      ports: [80], memoryMiB: 12, cpuMillis: 5, startMs: 400, sizeBytes: 67_000_000,
      http: { '/': { status: 200, body: '<html><h1>Welcome to nginx!</h1></html>\n' } },
      logs: { start: ['/docker-entrypoint.sh: Configuration complete; ready for start up', '2026/10/05 09:12:01 [notice] 1#1: start worker processes'] },
      description: 'Plain nginx. Listens on 80.',
    },
    'nginx:1.25': {
      ports: [80], memoryMiB: 12, cpuMillis: 5, startMs: 400, sizeBytes: 67_000_000,
      http: { '/': { status: 200, body: '<html><h1>Welcome to nginx!</h1></html>\n' } },
      logs: { start: ['/docker-entrypoint.sh: Configuration complete; ready for start up'] },
    },
    'busybox:1.36': {
      ports: [], memoryMiB: 4, cpuMillis: 1, startMs: 100, sizeBytes: 2_200_000,
      runToCompletion: { durationMs: 50, exitCode: 0 },
      logs: {},
      description: 'busybox: exits immediately unless given a command (sleep/sh).',
    },
    'busybox:latest': {
      ports: [], memoryMiB: 4, cpuMillis: 1, startMs: 100, sizeBytes: 2_200_000,
      runToCompletion: { durationMs: 50, exitCode: 0 },
      logs: {},
    },
    'redis:7': {
      ports: [6379], memoryMiB: 20, cpuMillis: 10, startMs: 500, sizeBytes: 41_000_000,
      logs: { start: ['1:C 05 Oct 2026 09:12:00.000 * oO0OoO0OoO0Oo Redis is starting oO0OoO0OoO0Oo', '1:M 05 Oct 2026 09:12:00.002 * Ready to accept connections tcp'] },
      description: 'Redis. Listens on 6379, no HTTP.',
    },
    'registry.orbital.local/freight/frontend:1.4.0': {
      ports: [8080], memoryMiB: 64, cpuMillis: 30, startMs: 1200, sizeBytes: 52_000_000,
      http: { '/': { status: 200, body: 'freight-frontend 1.4.0 ok\n' }, '/healthz': { status: 200, body: 'ok' }, '/readyz': { status: 200, body: 'ok' } },
      logs: { start: ['{"level":"info","msg":"freight-frontend 1.4.0 starting","port":8080}', '{"level":"info","msg":"listening","addr":":8080"}'], loop: ['{"level":"info","msg":"GET / 200","latency_ms":12}'], loopEveryMs: 4000 },
      description: 'Freight scheduling frontend.',
    },
  });
}

/** Resolved process behaviour helpers. */
export function httpResponse(b: ResolvedBehaviour, path: string, uptimeMs: number): HttpResponse {
  const table = b.http ?? { '/': { status: 200, body: 'ok\n' } };
  const clean = path.split('?')[0] as string;
  const r = table[clean] ?? table[clean.replace(/\/$/, '') || '/'];
  if (!r) return { status: 404, body: '404 page not found\n' };
  const warm = r.warmupMs ?? b.readyAfterMs;
  if (warm && uptimeMs < warm) return { status: 503, body: 'warming up\n' };
  return r;
}
