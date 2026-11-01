# ARCHITECTURE.md — Kubequest

Living map of the codebase. Update it with every structural change (see `AGENTS.md` §2).
Design rationale lives in `docs/TECH_SPEC.md`; this file describes **what exists** and where to
extend it.

## 1. Layers and the dependency rule

```
src/desktop   Electron main + preload. Loads dist/web. Imports nothing from src/.
src/ui        DOM/Canvas. Imports game + engine.
src/game      Mission DSL, runtime, scoring, progress, storage. Imports engine only.
src/missions  Content (data modules). Imports game types + engine types/helpers.
src/engine    The simulated cluster + kubectl + shell. Pure: no DOM, no timers, no Math.random.
```
`engine ← game ← ui`; `missions → game`; `desktop` is isolated. Enforced by review; a quick
check: `grep -r "from '../ui" src/engine src/game` must be empty.

## 2. Engine (`src/engine`)

| Module | Responsibility | Extend here when… |
|---|---|---|
| `engine.ts` | `Engine`: clock, RNG, store, runtimes, IP allocation, `tick()` controller order, `ClusterSetup` → initial objects with ages (fast-forward) | adding a controller (append to `tick()`), new cluster-level knobs |
| `clock.ts`, `rng.ts` | deterministic time and randomness (`suffix()`, `hash()` mimic upstream encodings) | — |
| `store.ts` | `ClusterStore`: objects as JSON by kind/ns/name + uid, resourceVersion/generation, graceful `markDeleting`, owner refs, **events** (dedup with count) | new server-side behaviours (finalizers, watch) |
| `registry.ts` | resource kinds, groups, plurals, short names, `qualifiedName()` | adding a kind (one row) |
| `types.ts` | TS shapes of API objects (subset) | adding fields/kinds |
| `defaults.ts` | API-server defaulting (probes, strategy, tolerations, QoS) | new kinds' defaults |
| `images.ts` | image catalogue + `ContainerBehaviour` (process simulation knobs) | new app behaviours, failure modes |
| `runtime.ts` | per-pod/per-node sim state kept **outside** objects | new runtime facts |
| `appsim.ts` | how a container answers TCP/HTTP (probes, traffic, curl share it) | protocol features |
| `controllers/kubelet.ts` | pulls, start/crash/backoff, probes, OOM, graceful stop, `status` | container lifecycle fidelity |
| `controllers/scheduler.ts` | filters (resources, selectors, taints, affinity), scoring, `FailedScheduling` text | scheduling features (spread, priority) |
| `controllers/node.ts` | Ready/NotReady, taints, taint-based eviction, `setNodeReady` chaos hook | node features |
| `controllers/replicaset.ts` | reconcile, adoption/release, deletion ranking | — |
| `controllers/deployment.ts` | RS per template hash, RollingUpdate/Recreate maths, revisions, rollback, conditions | strategies, progress deadline tuning |
| `controllers/daemonset.ts`, `job.ts` | DaemonSet; Job/CronJob (cron parser in `job.ts`) | StatefulSet (new file) |
| `controllers/service.ts` | ClusterIP/NodePort/LB allocation, Endpoints + EndpointSlice sync, `resolveDns` | Ingress/Gateway, NetworkPolicy |
| `controllers/gc.ts` | owner cascade, non-pod deletions | finalizers |
| `traffic.ts` | synthetic requests per Service, SLO window, packet buffer (`drain()` for UI) | request patterns, latency |
| `vfs.ts` | in-memory workstation files | — |
| `shell.ts` | `Shell`: pipes, redirects, `$(…)`, `&` jobs, builtins (`grep`, `curl` …), history (`line` + `expanded`), Tab completion | new builtins, completion rules |
| `container-shell.ts` | busybox-like `exec`/`-it` shell inside containers, cluster HTTP/DNS | tools inside images |
| `testing.ts` | `scriptedHost`, `runLine`, `makeShell` for tests/solutions | — |

### kubectl (`src/engine/kubectl`)
`index.ts` dispatches `tokens[0]` to a `KubectlCommand` (`context.ts` contract: async generator of
`OutputChunk`, `ShellHost` for sleep/editor/readLine/abort). `args.ts` is pflag-compatible
(combined shorts, `--flag=value`, `--`), `resources.ts` resolves `TYPE NAME | TYPE/NAME | a,b`
plus namespace rules, `printers.ts` + `tabwriter.ts` reproduce `kubectl get` tables,
`describe.ts` the `describe` layouts, `output.ts` `-o yaml|json|name|jsonpath` (`jsonpath.ts`),
`validate.ts` the OpenAPI-style unknown-field and semantic validation with upstream strings,
`unsupported.ts` the honest failure path, `explain-docs.ts`/`help-text.ts` static docs.
Commands live in `commands/`: `get`, `describe`, `apply` (+`create`, `edit`), `imperative`
(`run`, `delete`, `scale`, `label`, `annotate`, `expose`), `rollout` (+`set`), `logs` (+`exec`,
`port-forward`), `misc` (`config`, `version`, `cluster-info`, `api-resources`, `explain`, `top`,
`wait`, `cordon`, `uncordon`, `drain`, `help`).

**Adding a command:** create `commands/foo.ts` exporting a `KubectlCommand`, register it in
`index.ts` `COMMANDS`, add completion in `shell.ts` if it takes resources, add a test in
`tests/engine/kubectl.test.ts` with golden output, update `help-text.ts` and `docs/MVP_SCOPE.md`.

## 3. Game (`src/game`)
- `mission.ts` — `Mission` DSL (ticket, concept cards, `ClusterSetup`, files, objectives with
  `check(ctx)`, chaos timeline, hints, par/SLA/SLO, `solution` steps), `ClusterView` typed queries.
- `runtime.ts` — `MissionRuntime`: owns `Engine` + `Shell` + `Vfs`; `tick()` → engine tick,
  objective evaluation, chaos firing, SLA; `paused` freezes everything (no ticks, no traffic, no
  timer); emits `RuntimeEvent`s; `complete()` → `scoring.ts`. A restart is simply a new runtime
  built from the same `Mission` (setup is deterministic by seed).
- `scoring.ts` — score weights and star thresholds (see TECH_SPEC §4.2).
- `progress.ts` + `storage.ts` — versioned player data behind a `Storage` interface
  (`BridgeStorage` for Electron IPC, `LocalStorage` for browsers, `MemoryStorage` for tests).

## 4. Missions (`src/missions`)
`lib.ts` holds the Orbital Logistics image catalogue (`ORBITAL_IMAGES`), object builders
(`deployment`, `service`, `pod`, `configMap`), cluster presets (`orbitalNodes`, `systemWorkloads`)
and objective helpers (`usedCmd`, `usedCmdAll`, `outputHad`). Chapters are `chN.ts`; `lessons.ts` holds each mission's briefing lesson and `insights.ts` the per-objective
insights, both keyed by id and merged in `index.ts`; `index.ts` orders chapters and defines unlocking; `sandbox.ts` is free play.
**Adding a mission:** write it in the chapter file, add to the chapter array, include a
`solution`; `tests/missions/solvability.test.ts` picks it up automatically and requires ≥2 stars.

## 5. UI (`src/ui`)
`main.ts` (`App`: screens, fixed-step loop `rt.tick(100ms)` from rAF, event wiring, error
nudges, pause/restart, `?mission=&script=&tab=&paused=1` deep links) · `terminal.ts` (scrollback, history, completion,
streaming, interactive sessions, implements `ShellHost` with real-time sleeps) · `editor.ts`
(modal YAML editor) · `map.ts` (canvas scene: service hubs, node racks with request bars, pod
tiles by status, packet flights, warning ticker) · `panels.ts` (top bar, side tabs: Objectives / Insights / Ticket / Concepts / Pager) ·
`screens.ts` (campaign, briefing, debrief, settings, toasts) · `dom.ts` (helpers).
Styles: `web/styles.css` (CSS variables; status colours always paired with glyphs/text).

## 6. Desktop (`src/desktop`) and build
`main.ts` sets all Electron paths under `<app>/data` (portable) when run from source and uses
the standard `userData` dir when `app.isPackaged`; single window, CSP, sandboxed renderer, IPC
`storage:read/write` to `<dataDir>/*.json`. `preload.ts` exposes `window.kubequest`.
`scripts/build.mjs` (esbuild: `dist/web/app.js`, `dist/desktop/*.cjs`), `scripts/serve.mjs`
(browser fallback), `scripts/footprint.mjs` (host hygiene check).
Packaging: `electron-builder.yml` + `scripts/package.mjs` (cache in `.cache/electron-builder`,
output in `release/`), `scripts/after-pack.cjs` (Linux sandbox-fallback launcher),
`scripts/deb/{postinst,postrm}.sh` (deb hooks), `.github/workflows/build.yml` (native-runner
builds for Linux/Windows/macOS, draft release on `v*` tags).

## 7. Tests (`tests/`)
`engine/yaml.test.ts`, `engine/controllers.test.ts` (scenario tests with `engine.advance`),
`engine/kubectl.test.ts` (end-to-end through the shell; golden layouts and error strings),
`missions/solvability.test.ts` (every mission's solution, run through `MissionRuntime`),
`missions/content.test.ts` (lesson, insight and concept-card rules),
`game/runtime.test.ts` (pause/restart semantics).
Run with `npm test` (Node's test runner, TypeScript stripped natively).

## 8. Extension points (designed in)
- **Real cluster backend**: `ShellHost` + `Shell` are the only UI-facing contracts. A
  `KubectlProxyBackend` would implement `exec(line)` by spawning the user's `kubectl` and feed
  the map from `kubectl get -o json` into a read-only `ClusterStore`.
- **New kinds**: registry row + types + defaults + validator schema + printer columns + describe.
- **Chapters 5–8**: ConfigMap/Secret volumes and StatefulSet/PV/PVC need a storage controller;
  RBAC needs an identity on `CommandContext` and `kubectl auth can-i`; NetworkPolicy plugs into
  `appsim.requestPod`; HPA reads `podUsage`; PDB gates `drain` and the RS deletion path.
- **Challenge mode**: `MissionRuntime` already takes a mission; a generator that remixes
  `chaos` with a seed is all that is missing.

## 9. Known gaps (tracked as `TODO(fidelity)`)
`describe` for StatefulSet/Ingress; `get -w --output-watch-events`; `patch`/`diff`/`debug`;
`custom-columns`; multiple kubeconfig contexts; init containers run as regular containers;
DaemonSet pods set `nodeName` through affinity only.
