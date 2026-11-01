# Kubequest — Technical Specification

**Status:** v1.3 (self-iterated; see §14)
**Input:** `docs/PRD.md` (what & why). **Output:** `docs/MVP_SCOPE.md` (what first), `ARCHITECTURE.md` (living map of the code).
**Boundary:** this document decides *how* the product is built and defines the contracts between subsystems. It does not decide feature priority (MVP doc) and does not restate product rationale (PRD).

---

## 1. Technology decisions

| Decision | Choice | Why (ties to PRD §8) | Rejected alternatives |
|---|---|---|---|
| Cluster backend | **In-process simulated Kubernetes** (own control plane written in TypeScript) | Zero setup, zero footprint, deterministic, instant, animatable, offline. Behaviour is specified against real K8s semantics (§5). | kind/minikube/k3d (needs Docker, GBs of images, pollutes host, not deterministic); remote sandbox (needs network/accounts) |
| Language | **TypeScript (strict)**, ES2022 modules | One language for engine, UI and shell; Node 24 runs `.ts` natively for tests (no transpiler in the test path) | Go+webview (needs cgo/webkit), Rust/Tauri (toolchain not available, heavier dev deps) |
| UI | **Vanilla DOM + Canvas 2D**, no framework | Minimal deps, full control over animation, tiny bundle | React/Phaser (deps, bundle size, no real need) |
| Desktop shell | **Electron**, *portable mode* when run from source (userData redirected into the app folder); standard per-user `userData` when installed | Cross-platform desktop windows with one dev dependency; web fallback is free | Tauri (Rust), NW.js, native |
| Fallback | `npm run web`: Node's built-in `http` serves `dist/web`, opens default browser | Works with zero native deps; also used for CI smoke tests | — |
| Build | **esbuild** (bundle UI + Electron main), **tsc --noEmit** (type check) | Fast, single binary, no config sprawl | webpack/vite (heavier) |
| Tests | **`node --test`** on `.ts` sources directly | No test framework dep | vitest/jest |
| Runtime deps | **Zero.** Own YAML parser/emitter, own arg parser, own jsonpath subset | PRD "minimal dependencies"; everything auditable | js-yaml, yargs |
| Dev deps | `typescript`, `esbuild`, `electron`, `electron-builder` (installers: AppImage/deb, NSIS, dmg) | All local to project; electron-builder is the only cross-platform installer toolchain that needs no native deps of its own and is already proven in the sibling project Sway The People! | `@electron/packager` (zip only, no installers) |
| Persistence | JSON file under `<app>/data/` (Electron) / `localStorage` (browser), behind a `Storage` interface | Delete folder = clean uninstall | OS app-data dirs |

Development hygiene (host constraints): `npm_config_cache` and `ELECTRON_CACHE` point to `./.cache/` so no bytes land outside the project folder. See `AGENTS.md`.

## 2. System overview

```
┌──────────────────────────────── UI (src/ui) ──────────────────────────────┐
│  TopBar(ticket, timer, SLO, score)   ClusterMap(canvas)   SidePanel        │
│  Terminal(input, scrollback, completion)  Editor(YAML)   Debrief/Briefing   │
└────────────▲───────────────────────────────┬──────────────────────────────┘
             │ render snapshot / events       │ exec(line), tick(dt), ui actions
┌────────────┴───────────────────────────────▼──────────────────────────────┐
│                         GameSession (src/game)                             │
│   MissionRuntime(objectives, chaos, hints, scoring)  Profile/Progress       │
└────────────▲───────────────────────────────┬──────────────────────────────┘
             │ ClusterView (read)             │ Shell.exec / Engine.tick
┌────────────┴───────────────────────────────▼──────────────────────────────┐
│                           Engine (src/engine)  — pure, DOM-free            │
│  Shell(builtins, pipes, redirects, VFS)  →  kubectl(parse → command → printer) │
│  ClusterStore(objects, events)  ◄── Controllers (scheduler, deploy, rs, ds, │
│  job, cronjob, sts, endpoints, kubelet, node, gc)  ◄── Clock + RNG(seed)    │
│  ImageCatalog(behaviours)   TrafficSim(SLO)   InContainerShell              │
└───────────────────────────────────────────────────────────────────────────┘
┌────────────── Shell layer: Electron main/preload (src/desktop) or browser ─┐
```

**Dependency rule:** `engine` imports nothing from `game`/`ui`; `game` imports `engine`
only; `ui` imports both; `desktop` imports none of them (it only loads the bundle).
Missions are data modules under `src/missions` consumed by `game`.

## 3. Engine

### 3.1 Clock, determinism, ticking
- `Clock`: game time in ms, starts at a mission-defined epoch (so AGE columns are
  meaningful, e.g. the cluster "has existed for 14 days"). Pausable. `timeScale`
  (default 1).
- `Engine.tick(dtMs)`: advances clock, runs controllers in fixed order (§3.5), runs
  traffic, flushes events. Tick quantum 100 ms; UI calls it from `requestAnimationFrame`
  with accumulated real time (fixed-step loop).
- `Rng(seed)`: xorshift128+; all randomness (pod suffixes, scheduling ties, chaos,
  traffic jitter) goes through it. Missions are reproducible by seed.

### 3.2 Object store
- Objects are plain JSON in Kubernetes shape (`apiVersion`, `kind`, `metadata`,
  `spec`, `status`). This makes `-o yaml|json|jsonpath` trivial and exact.
- `ClusterStore` indexes by `kind/namespace/name` and `uid`. Provides `get`, `list`
  (with label/field selector), `create`, `update` (bumps `resourceVersion`,
  `metadata.generation` on spec change), `delete` (sets `deletionTimestamp` for Pods
  with graceful termination, immediate for others), `watch` (in-process listeners).
- Per-object **runtime state** (container processes, probe timers, backoff) lives in a
  side map keyed by uid, never in the object, so `-o yaml` never leaks sim internals.
- Owner references + garbage collection (background cascade, like real K8s): deleting
  a Deployment deletes its RSs, which deletes their Pods. `--cascade=orphan` honoured.
- Validation on admission: schema subset per kind (required fields, name RFC-1123,
  label key/value rules, selector must match template labels, immutability of RS/
  Deployment selector, StatefulSet/Job fields), producing real error strings:
  `The Deployment "web" is invalid: spec.template.metadata.labels: Invalid value: … `selector` does not match template `labels``.

### 3.3 Resource types (full target; MVP subset in MVP doc)
`Namespace, Node, Pod, ReplicaSet, Deployment, DaemonSet, StatefulSet, Job, CronJob,
Service, Endpoints, EndpointSlice, Ingress, ConfigMap, Secret, ServiceAccount, Event,
PersistentVolume, PersistentVolumeClaim, StorageClass, HorizontalPodAutoscaler,
PodDisruptionBudget, ResourceQuota, LimitRange, NetworkPolicy, Role, RoleBinding,
ClusterRole, ClusterRoleBinding, CustomResourceDefinition (+ dynamic kinds)`.
Each kind registers: api group/version, plural, short names, namespaced?, printer
columns (normal/wide), describe renderer, validator, defaulter.

### 3.4 Image catalogue
Fictional registry `registry.orbital.local/<app>:<tag>` plus a few public lookalikes
(`nginx:1.27`, `busybox:1.36`, `redis:7`). Each tag maps to a `ContainerBehaviour`:
```ts
interface ContainerBehaviour {
  pullMs: number;                 // first pull per node; cached afterwards
  startMs: number;                // time from Created to process listening
  ports: number[];
  cpuMillis: number; memoryMiB: number;     // steady usage (OOMKill if limit < memory)
  requiresEnv?: string[];         // exit 1 with log line if missing
  requiresFiles?: string[];       // exit 1 if mounted file missing (ConfigMap/Secret)
  crashAfterMs?: number;          // deterministic bug → Terminated(exit 1)
  readiness: { path: string; readyAfterMs: number } | 'never';
  liveness: { path: string; failAfterMs?: number };   // app hangs after N ms
  sigtermGraceMs: number;         // how long it takes to exit on SIGTERM (∞ = ignores)
  http: Record<string, string>;   // canned HTTP responses for in-container curl / traffic
  logs: LogScript;                // ordered lines with offsets (+ loop section)
  files: Record<string, string>;  // for `exec cat`
}
```
Unknown image/tag ⇒ `ErrImagePull` → `ImagePullBackOff` with faithful event message
(`Failed to pull image "...": ... not found: manifest unknown`).

### 3.5 Controllers (fixed order per tick)
1. **NodeLifecycle** — Ready/NotReady conditions; NotReady > 5 min (mission-tunable)
   ⇒ taint `node.kubernetes.io/unreachable:NoExecute`, pods evicted (deleted; RS replaces).
2. **Scheduler** — for each unscheduled Pod: filter nodes (Ready, not cordoned,
   nodeSelector, nodeName, taints/tolerations, requests ≤ allocatable − requested,
   required affinity/anti-affinity, topology spread (later)), score (least-requested
   + spread), bind. On failure, emit `FailedScheduling` with the real message
   format: `0/3 nodes are available: 1 node(s) had untolerated taint {…}, 2 Insufficient memory. preemption: …`.
3. **Kubelet** — per scheduled Pod: image pull (per-node cache), container start,
   probes (startup → readiness/liveness with `initialDelaySeconds`, `periodSeconds`,
   `failureThreshold`, `successThreshold`, `timeoutSeconds`), restarts with backoff
   (10 s doubling, cap 5 min, reset after 10 min stable), OOMKill, graceful
   termination (`terminationGracePeriodSeconds`, image's SIGTERM behaviour), status
   (`phase`, `conditions`, `containerStatuses`, `podIP`, `hostIP`, `startTime`).
4. **ReplicaSet** — reconcile `spec.replicas` for owned pods matching selector
   (adopt orphans with matching labels, like real K8s); delete surplus choosing
   unready/newest first (real ordering); emits `SuccessfulCreate/Delete`.
5. **Deployment** — pod-template-hash RS management, RollingUpdate (maxSurge /
   maxUnavailable, exact upstream algorithm), Recreate, `minReadySeconds`,
   `revisionHistoryLimit`, `progressDeadlineSeconds` → `ProgressDeadlineExceeded`,
   revisions via `deployment.kubernetes.io/revision`, rollback, pause/resume.
6. **DaemonSet** — one pod per eligible node (node selectors/taints), RollingUpdate.
7. **StatefulSet** — ordinal names, ordered start/termination, headless service DNS,
   `volumeClaimTemplates` → PVCs.
8. **Job / CronJob** — completions, parallelism, backoffLimit, indexed mode,
   `ttlSecondsAfterFinished`; CronJob schedule (5-field cron parser), concurrencyPolicy,
   history limits.
9. **Endpoints/EndpointSlice** — ready pods matching selector (readiness gates traffic),
   `publishNotReadyAddresses`, headless services.
10. **Service** — ClusterIP allocation (10.96.0.0/12), NodePort (30000–32767), LB external
    IP after a delay (fictional cloud: 203.0.113.0/24), DNS table.
11. **HPA / PDB / Quota / LimitRange** — later chapters.
12. **GarbageCollector** — ownerReference cascade, finished-pod/Job TTL.
13. **TrafficSim** — see §3.7.

Timings follow real defaults; missions may set `clusterConfig.timeScale` for pacing.
Where a real default would make a mission tedious (30 s grace period), the *image*
exits quickly instead — the K8s semantics stay exact.

### 3.6 kubectl implementation
- **Parser:** tokenizer (quotes, escapes, `=`), then per-command flag spec (long,
  short, repeated, `--flag value` and `--flag=value`), resource argument forms:
  `TYPE NAME…`, `TYPE/NAME…`, `TYPE1,TYPE2`, `-f FILE` (multi-doc YAML/JSON, `-R`
  dirs, `-k` later). Type resolution via plural/singular/short names/`kind.group`.
- **Commands** are modules implementing:
  ```ts
  interface KubectlCommand {
    name: string; aliases?: string[]; flags: FlagSpec[]; usage: string;
    run(ctx: CommandContext): AsyncGenerator<OutputChunk, number /*exit code*/>;
  }
  ```
  Long-running commands (`rollout status`, `logs -f`, `get -w`, `port-forward`,
  `wait`, `exec -it`) yield chunks and `await ctx.sleep(ms)` while the engine keeps
  ticking; Ctrl+C aborts via `ctx.signal`.
- **Printers:** table printer identical to `kubectl` (two-space alignment, `AGE`
  via upstream `HumanDuration`, `-o wide`, `--show-labels`, `-L`, `--no-headers`,
  `-A` adds `NAMESPACE`), `-o yaml|json|name|jsonpath|custom-columns`, `get all`
  grouping. `describe` renderers mirror upstream layout per kind including Events.
- **Errors:** exact upstream strings: `Error from server (NotFound): pods "x" not found`,
  `error: the server doesn't have a resource type "foo"`, `No resources found in default namespace.`,
  `error: unknown flag: --x`, `error: unknown command "x" for "kubectl"`,
  `error: error validating "f.yaml": …`. A Kubequest nudge, when present, is printed
  *after* the error, prefixed `hint:` in a distinct colour and only if the mission's
  hint level allows it.
- **Unsupported:** a known-but-unimplemented command/flag prints
  `kubequest: "<cmd>" is not supported in the simulator yet (see help kubectl)` with exit 1.
- `kubectl explain` uses a bundled field-doc table (common paths), `api-resources`
  reflects the registry, `config` manipulates an in-memory kubeconfig (contexts →
  clusters; multi-cluster missions later).

### 3.7 Traffic simulation & SLO
- Mission declares traffic sources: `{ target: "ns/service[:port]" | "ingress-host", rps, pattern }`.
- Each tick: `rps·dt` requests (Poisson jitter via RNG) → resolve DNS → Service →
  ready endpoints → round-robin to pods → image's canned response (`200`) or
  failure (`503` if pod not ready but still in endpoints—only via
  `publishNotReadyAddresses`, `connection refused` if pod gone). No endpoints ⇒
  dropped. Terminating pods leave endpoints immediately (as in K8s).
- `SloStats`: rolling 60 s window of served/dropped, plus mission totals. Exposed to
  UI (meter) and to objectives ("availability ≥ 99 % during rollout").

### 3.8 Shell & VFS
- `Shell.exec(line)` supports: `kubectl`/`k`, builtins (`ls`, `cat`, `cd`, `pwd`,
  `echo`, `clear`, `help`, `history`, `alias`, `export`, `env`, `vim|vi|nano|edit`
  → opens editor), pipes to `grep [-i|-v|-c|-E]`, `head`, `tail`, `wc -l`, `sort`,
  `uniq`, `awk '{print $N}'` (subset), redirects `>`/`>>` into the VFS, `&&`/`;`,
  env expansion `$VAR`, globbing `*.yaml` in VFS.
- VFS: in-memory tree seeded by the mission; persists per mission attempt.
- In-container shell (`kubectl exec -it POD -- sh`): `ls`, `cat`, `env`, `hostname`,
  `ps`, `nslookup`/`dig` (cluster DNS), `curl`/`wget` (to services/pods via sim),
  `exit`. Prompt `/ #`. Teaches DNS & service connectivity hands-on.

## 4. Game layer (`src/game`)

### 4.1 Mission DSL (TypeScript data modules)
```ts
interface Mission {
  id: string; chapter: number; order: number; title: string;
  ticket: { from: string; priority: 'P1'|'P2'|'P3'|'P4'; subject: string; body: string[] };
  concepts: ConceptCard[];                // { title, body(md-lite), example? }
  cluster: ClusterSetup;                   // nodes, namespaces, objects, images, epoch, seed
  files?: Record<string, string>;          // VFS seed (relative to ~/)
  traffic?: TrafficSource[];
  objectives: Objective[];                 // { id, text, check(ctx): boolean, optional?, hiddenUntil? }
  chaos?: ChaosEvent[];                    // { at: {afterSec} | {whenObjective} , do: ChaosAction, announce? }
  hints: Hint[];                           // ordered; { text, starCost }
  par: { timeSec: number; commands: number }; timeLimitSec?: number;
  slo?: { minAvailability: number };       // star condition
  solution: string[];                      // scripted commands; used by tests to prove solvability
  debrief: { proTips: string[] };
}
```
`ObjectiveContext` exposes read-only `ClusterView` (typed query helpers:
`pods({ns, selector})`, `deployment(ns,name)`, `endpointsReady(ns,svc)`, …), command
`history`, `slo`, `elapsed`, `flags` set by chaos.

### 4.2 Runtime, scoring, progression
- `MissionRuntime` owns an `Engine`, evaluates objectives every tick (debounced UI),
  schedules chaos, tracks hints used, computes score on completion:
  `score = 1000·objectives + timeBonus(par) + efficiencyBonus(par.commands) + sloBonus − 150·hints`.
  Stars: ≥ 1800 → 3, ≥ 1200 → 2, else 1. A mission with `slo` requires
  `availability ≥ minAvailability` for 3 stars.
- `Progress` (persisted): per-mission best score/stars/time, unlocked chapters,
  stats, settings. Schema versioned for migrations.
- Modes: Campaign (missions in order, unlock by stars), Challenge (mission + random
  chaos profile + seed), Sandbox (choose a cluster preset, no objectives).

## 5. UI (`src/ui`)
- **Layout** (CSS grid): top bar; left 60 % cluster map (canvas); right 40 % tabbed
  panel (Ticket / Objectives / Concepts / Hints); bottom terminal (resizable). Editor
  and briefing/debrief are modal layers.
- **ClusterMap renderer:** scene graph built from `ClusterView` each frame diff:
  nodes as racks (capacity bars), pods as tiles grouped by workload with status
  glow (Pending amber, Running green, CrashLoop red pulse, Terminating fade),
  services as hubs, traffic as packets travelling edges (served green, dropped red
  shards), events as toast bubbles. Layout is deterministic (stable positions).
  Reduced-motion mode disables packets/pulses.
- **Terminal:** custom (no xterm): prompt, scrollback with colour spans, history,
  Tab completion (asks engine for candidates), Ctrl+C/L, streaming output.
- **Editor:** textarea + line numbers, YAML syntax tint, `Ctrl+S` save, `Esc` cancel,
  vim-style `:wq`/`:q!` accepted in the command strip for muscle memory.
- **Accessibility:** all state available as text (objectives, pod list), focus
  order, high-contrast palette, status shapes not only colours.

## 6. Desktop shell (`src/desktop`)
- `main.ts`: `app.setPath('userData', <appRoot>/data)`; single window; loads
  `dist/web/index.html`; CSP; no remote content; `contextIsolation: true`.
- `preload.ts`: exposes `storage.read/write(key)` over IPC (files under `data/`).
- Browser fallback uses `localStorage` with the same interface.
- Packaging: `electron-builder` (`electron-builder.yml`, `scripts/package.mjs`) → Linux
  AppImage + deb, Windows NSIS, macOS dmg (arm64 + x64, unsigned). `files: dist/**` only.
  `app.isPackaged` switches `dataDir` to Electron's standard `userData`, because installed
  apps cannot write next to themselves. Linux builds get a launcher (`scripts/after-pack.cjs`)
  that falls back to `--no-sandbox` only when no Chromium sandbox is usable; the deb's
  `postinst` makes `chrome-sandbox` SUID so installs stay sandboxed.

## 7. Build & tooling
```
npm run build      # esbuild: ui bundle + desktop main/preload → dist/
npm start          # build + scripts/start.mjs (Electron; adds --no-sandbox only on Linux hosts that restrict user namespaces)
npm run web        # build + serve dist/web on 127.0.0.1 + open browser
npm test           # node --test tests/**/*.test.ts
npm run typecheck  # tsc --noEmit
npm run check      # typecheck + test (CI gate)
npm run build:linux|build:win|build:mac   # electron-builder → release/ (each on its own OS)
```
`.cache/` (npm, electron and electron-builder caches) and `dist/`, `release/`, `node_modules/`,
`data/` are git-ignored and live inside the project folder. `.github/workflows/build.yml`
builds all three platforms on native runners and drafts a release on `v*` tags.

## 8. Testing strategy
1. **Unit:** YAML parser/emitter round-trips; arg parser; `HumanDuration`; printers
   against golden strings captured from real `kubectl` (stored in
   `tests/golden/*.txt`); validators' error strings.
2. **Controller behaviour:** scripted scenarios with fast-forward (`engine.advance(sec)`),
   e.g. rolling update respects maxSurge/maxUnavailable; readiness gates endpoints;
   CrashLoopBackOff backoff sequence; scheduler messages.
3. **Mission solvability:** every mission's `solution` script is executed against a
   fresh engine; all objectives must complete. This is the regression net for both
   the simulator and the content.
4. **Smoke:** `npm run web` server starts and serves the bundle.

## 9. Performance budgets
Tick ≤ 1 ms for ≤ 100 pods; render ≤ 4 ms/frame; bundle ≤ 600 KB; memory ≤ 150 MB
(renderer). No timers run while paused/briefing.

## 10. Security
No network, no `eval`, CSP `default-src 'self'`, Electron `sandbox: true`,
`nodeIntegration: false`. VFS and in-container shell are purely in-memory.

## 11. Extension points (designed in, not built)
- `ClusterBackend` interface: `SimBackend` (this spec) and a future
  `KubectlProxyBackend` that executes the player's real `kubectl` and feeds the map
  from `kubectl get -o json` — same UI, real cluster.
- Mission packs as directories of data modules; CRDs via registry.
- Localisation: all strings in mission data; UI strings in one table.

## 12. Directory layout
```
src/engine/{clock,rng,store,registry,validate,yaml,jsonpath,printers,describe,
            kubectl/{parse,commands/*},controllers/*,images,traffic,shell,vfs,
            container-shell,view}
src/game/{mission,runtime,scoring,progress,storage}
src/missions/{ch0,ch1,...}/*.ts  + index.ts
src/ui/{app,terminal,map,panels,editor,briefing,debrief,theme}
src/desktop/{main,preload}.ts
web/{index.html,styles.css}
tests/**/*.test.ts, tests/golden/*
docs/{PRD,TECH_SPEC,MVP_SCOPE}.md  AGENTS.md  ARCHITECTURE.md  README.md
```

## 13. Open design questions → resolved
- *Real `kubectl` output drift across versions?* Target **kubectl v1.31–1.33**
  output; document version in `README`.
- *Tab completion fidelity?* Mirrors `kubectl completion` behaviour (types, names
  in current ns, flags) — good enough and teaches the real affordance.
- *Should the editor be vim-like?* No modal editing (accessibility); accept `:wq`.

## 14. Revision log
- v1.0 — Electron + simulated cluster + framework-free UI.
- v1.1 — Removed `js-yaml` (zero runtime deps); added golden-output tests; made
  commands async generators to support `rollout status`/`logs -f` faithfully.
- v1.2 — Added in-container shell (DNS/curl) after reviewing Stage 4 teachability;
  specified exact upstream Deployment rollout algorithm; side-map for runtime state
  so `-o yaml` is exact; GC cascade.
- v1.4 — Implementation notes: Node strip-only TS (no enums/parameter properties); shell records both typed and `$(…)`-expanded lines for objectives; traffic packets buffered for the renderer; Electron launcher handles the SUID-sandbox case.
- v1.3 — Added `solution` scripts as mission solvability tests; portable `userData`;
  `.cache/` inside project; performance/security budgets; backend extension point.
