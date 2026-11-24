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
| `store.ts` | `ClusterStore`: objects as JSON by kind/ns/name + uid, resourceVersion/generation, graceful `markDeleting` (unbound Pods go at once), owner refs, **events** (dedup with count; similar events combined after ten, like client-go's aggregator), `ApiError` | new server-side behaviours (watch) |
| `registry.ts` | resource kinds, groups, plurals, short names, `qualifiedName()`; CRD-backed kinds are added at run time (`useDynamicResources`) | adding a built-in kind (one row) |
| `types.ts` | TS shapes of API objects (subset) | adding fields/kinds |
| `defaults.ts` | API-server defaulting (probes, strategy, tolerations, QoS, requests from limits, default StorageClass, empty template metadata) | new kinds' defaults |
| `rbac.ts` | users, groups, ServiceAccount identities, `authorize()`, bootstrap ClusterRoles (`cluster-admin`, `admin`, `edit`, `view`), upstream Forbidden text | authorization features |
| `admission.ts`, `podsecurity.ts`, `cel.ts` | the admission chain run on every write: ServiceAccount, PriorityClass, LimitRange, Pod Security Admission, ValidatingAdmissionPolicy (CEL subset), ResourceQuota | a new admission plugin (append to `admit()`) |
| `patch.ts` | JSON merge patch, strategic merge patch, JSON patch | — |
| `encoding.ts` | base64, SHA-256, simulated X.509 certificates | — |
| `images.ts` | image catalogue + `ContainerBehaviour` (process simulation knobs) | new app behaviours, failure modes |
| `runtime.ts` | per-pod/per-node sim state kept **outside** objects | new runtime facts |
| `appsim.ts` | how a container answers TCP/HTTP (probes, traffic, curl share it): NetworkPolicy drops, proxies, upstream calls, load shedding | protocol features |
| `netpol.ts` | NetworkPolicy evaluation (`ingressAllowed`, `egressAllowed`, `dnsAllowed`) | policy features |
| `routing.ts` | L7 routing for Ingress (ingress-nginx) and Gateway API (Envoy Gateway): hosts, paths, weights, TLS | route features |
| `http.ts` | the `curl`/`wget` client shared by the workstation and containers | client flags |
| `containerfs.ts` | container files and volumes (emptyDir, ConfigMap, Secret, PVC) | volume types |
| `kustomize.ts` | `kustomize build` (v5.5 subset: resources, namespace, name prefix/suffix, labels, images, replicas, patches, generators with the upstream name hash) | more transformers |
| `helm.ts` | `helm` v3 for local charts: Go-template/Sprig subset, releases stored as Secrets, install/upgrade/rollback/history | template functions |
| `git.ts` | `git` for the workstation (one branch, one remote); remotes are what the GitOps controller reads | git commands |
| `controllers/kubelet.ts` | pulls (incl. pull secrets), init/sidecar/ephemeral containers, start/crash/backoff, probes, OOM, security contexts, volumes, graceful stop, `status` | container lifecycle fidelity |
| `controllers/scheduler.ts` | filters (resources incl. extended ones, selectors, taints, node/pod affinity, PVC binding, topology spread with `matchLabelKeys`), scoring, priority preemption, `FailedScheduling` text | scheduling features |
| `controllers/node.ts` | Ready/NotReady, taints, taint-based eviction, `setNodeReady` chaos hook | node features |
| `controllers/replicaset.ts` | reconcile, adoption/release, deletion ranking | — |
| `controllers/deployment.ts` | RS per template hash, RollingUpdate/Recreate maths, revisions, rollback, conditions | strategies, progress deadline tuning |
| `controllers/daemonset.ts`, `job.ts` | DaemonSet; Job/CronJob (cron parser in `job.ts`) | — |
| `controllers/statefulset.ts` | ordered Pods with stable names, one claim per ordinal from `volumeClaimTemplates`, ordered rolling update | update strategies |
| `controllers/storage.ts` | dynamic provisioning, PVC↔PV binding, `WaitForFirstConsumer`, reclaim policy, pvc-protection finalizer | CSI features |
| `controllers/hpa.ts` | HorizontalPodAutoscaler v2: Resource and Pods metrics, 15 s sync, tolerance, scale-down stabilization | metric types, `behavior` |
| `controllers/policy.ts` | namespace bootstrap (default ServiceAccount, `kube-root-ca.crt`), PDB status, quota status, the eviction API (`evictPod`) | — |
| `controllers/ingress.ts` | ingress-nginx and Envoy Gateway control loops: status, addresses, generated proxy Deployments | controllers for other classes |
| `controllers/crd.ts` | CRDs → dynamic kinds, OpenAPI validation of custom resources, the operator framework (`OperatorSpec.reconcile(api)`, run while the operator's Pod is Ready) | a new operator (a `ClusterSetup.operators` entry) |
| `controllers/gitops.ts` | Argo CD `Application`: fetch, render (Kustomize or plain YAML), diff, automated sync, self-heal, prune, health | sync options |
| `controllers/requeue.ts` | client-go's retry back-off for failed syncs (`syncDue`/`syncFailed`/`syncSucceeded`) | — |
| `controllers/service.ts` | ClusterIP/NodePort/LB allocation, headless Services and per-Pod DNS records, Endpoints + EndpointSlice sync, `resolveDns` | — |
| `controllers/gc.ts` | owner cascade, non-pod deletions, finalizers, event TTL (1 h) | — |
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
`api.ts` the write path every mutating command goes through (authorize → admit → store, warnings,
`formatApiError`), `printers-ext.ts`/`describe-ext.ts` the layouts of the post-MVP kinds (and a
generic describer for custom resources), `unsupported.ts` the honest failure path,
`explain-docs.ts`/`help-text.ts` static docs.
Commands live in `commands/`: `get`, `describe`, `apply` (+`create`, `edit`), `imperative`
(`run`, `delete`, `scale`, `label`, `annotate`, `expose`), `rollout` (+`set`), `logs` (+`exec`,
`port-forward`), `misc` (`config`, `version`, `cluster-info`, `api-resources`, `explain`, `top`,
`wait`, `cordon`, `uncordon`, `drain`, `help`), `extra` (`auth`, `taint`, `autoscale`, `patch`,
`debug`, `kustomize`), `generators` (the `kubectl create <kind>` generators). The global flags
`--as`/`--as-group` set `CommandContext.user`; reads and writes are authorized against it.

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
- `version.ts` — app version for the UI (`resolveVersion`): package.json read live in development
  (Electron `app:version` IPC, or `version.json` from `scripts/serve.mjs`), build-time `__KQ_VERSION__`
  (esbuild `define`, declared in `build-globals.d.ts`) in packaged builds and static hosting
  (`BridgeStorage` for Electron IPC, `LocalStorage` for browsers, `MemoryStorage` for tests).

## 4. Missions (`src/missions`)
`lib.ts` holds the Orbital Logistics image catalogue (`ORBITAL_IMAGES`), object builders
(`deployment`, `service`, `pod`, `configMap`), cluster presets (`orbitalNodes`, `systemWorkloads`)
and objective helpers (`usedCmd`, `usedCmdAll`, `outputHad`). Chapters are `chN.ts`; `lessons.ts` holds each mission's briefing lesson and `insights.ts` the per-objective
insights, both keyed by id and merged in `index.ts`; `index.ts` orders chapters and defines unlocking; `sandbox.ts` is free play.
`platform.ts` holds the cluster add-ons missions install as seed objects — `ingressNginx()`,
`gatewayApiCrds()`/`envoyGateway()`, `argoCd()`, `storageClass()`, `tlsPair()` — and the `crd()`/`S`
helpers for writing CRDs. Chapters: `ch0`–`ch4`, `ch4b` (routing and network policy), `ch5`
(configuration, state, security), `ch6` (production operations), `ch7` (delivery and extension), `ch8`
(specialization tracks). Operators that missions need (the RouteCache operator in 7.4, the Chaos Mesh
PodChaos controller in 8.3) are `OperatorSpec`s defined next to the mission.
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
`storage:read/write` to `<dataDir>/*.json`, `app:version` (live package.json from source, build-time
version when packaged). `preload.ts` exposes `window.kubequest` (`storage`, `platform`, `version`).
`scripts/build.mjs` (esbuild: `dist/web/app.js`, `dist/desktop/*.cjs`; injects `__KQ_VERSION__`
from package.json), `scripts/serve.mjs` (browser fallback; serves `/version.json` live), `scripts/footprint.mjs` (host hygiene check).
Packaging: `electron-builder.yml` + `scripts/package.mjs` (cache in `.cache/electron-builder`,
output in `release/`), `scripts/after-pack.cjs` (Linux sandbox-fallback launcher),
`scripts/deb/{postinst,postrm}.sh` (deb hooks), `.github/workflows/build.yml` (native-runner
builds for Linux/Windows/macOS, draft release on `v*` tags).

## 7. Tests (`tests/`)
`engine/yaml.test.ts`, `engine/controllers.test.ts` (scenario tests with `engine.advance`),
`engine/kubectl.test.ts` (end-to-end through the shell; golden layouts and error strings),
`engine/platform.test.ts` (RBAC, admission, CRDs, storage, StatefulSets, scheduling, HPA, PDB/drain,
NetworkPolicy, Kustomize, Helm, GitOps, events and retry back-off),
`missions/solvability.test.ts` (every mission's solution, run through `MissionRuntime`),
`missions/content.test.ts` (lesson, insight and concept-card rules),
`game/runtime.test.ts` (pause/restart semantics).
Run with `npm test` (Node's test runner, TypeScript stripped natively).

## 8. Extension points (designed in)
- **Real cluster backend**: `ShellHost` + `Shell` are the only UI-facing contracts. A
  `KubectlProxyBackend` would implement `exec(line)` by spawning the user's `kubectl` and feed
  the map from `kubectl get -o json` into a read-only `ClusterStore`.
- **New kinds**: registry row + types + defaults + validator schema + printer columns + describe.
- **Operators**: a `ClusterSetup.operators` entry is a reconcile function that runs while a Pod of
  its image is Ready and acts with that Pod's ServiceAccount (`api.can`, `api.apply`, `api.setStatus`).
- **Cluster add-ons**: seed objects plus an image behaviour (for example `controller: 'argocd'`);
  see `missions/platform.ts`.
- **Lazy chapters**: chapter modules are independent, so the bundle can load them on demand if the
  size budget (TECH_SPEC §9) becomes a concern.
- **Challenge mode**: `MissionRuntime` already takes a mission; a generator that remixes
  `chaos` with a seed is all that is missing.

## 9. Known gaps (tracked as `TODO(fidelity)`)
`get -w --output-watch-events`; `diff`/`replace`/`cp`/`attach`; `custom-columns`; multiple kubeconfig
contexts; DaemonSet pods set `nodeName` through affinity only; here-documents in the terminal.
Deliberate simplifications of the post-MVP features:
- Error text that upstream builds from a Go struct dump is abbreviated (Job `spec.template` immutability
  prints `core.PodTemplateSpec{…}`; the PVC immutability error omits the trailing diff).
- The event recorder's spam filter (burst 25 per object) is not simulated; aggregation and the TTL are.
- A node taken down by a mission's chaos event turns NotReady at once (no 40 s monitor grace period).
- Helm templates and Kustomize fields outside the supported subset fail with a "not supported" error.
- Argo CD is the application controller only (no CLI, UI, projects or sync waves); syncs merge the
  desired manifest over the live object.
- Chaos Mesh is `PodChaos` with `action: pod-kill` only.
- Tick time at 100 pods is about 2 ms on a 2024 laptop — above the 1 ms budget, as it already was
  before the post-MVP controllers (most of it is `store.list` scans in the kubelet).
