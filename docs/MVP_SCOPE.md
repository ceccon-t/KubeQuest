# Kubequest — MVP Scope Document

**Status:** v1.2 (self-iterated; see §9)
**Input:** `docs/PRD.md` (product), `docs/TECH_SPEC.md` (technical contracts).
**Boundary:** this document decides *what ships first* and *what "done" means* for the
MVP. It does not change requirements (PRD) or contracts (Tech Spec); where it narrows
them it says so explicitly. Implementation follows `AGENTS.md` and is mapped in
`ARCHITECTURE.md`.

---

## 1. MVP goal

A playable vertical slice that proves the three pillars at once:
1. **It's a game** — stakes (traffic SLO, timers, chaos), score & stars, a visible,
   animated cluster that reacts to every command.
2. **It's correct** — every supported command behaves like `kubectl`; mission
   solutions execute as tests.
3. **It's self-contained** — runs from the project folder on Linux/macOS/Windows
   with Node only (`npm install && npm start`), or in a browser (`npm run web`);
   nothing written outside the folder.

Curriculum coverage target for the MVP: **Chapter 0 (orientation), Chapter 2
(kubectl fluency), Chapter 3 (core workloads) and the first two tickets of
Chapter 4 (Services)** — i.e. curriculum Stages 2–3 fully, Stage 4 partially.
Stage 1 is delivered as a briefing-only chapter (concept cards) in the MVP.

## 2. In scope

### 2.1 Engine — resource kinds
`Namespace, Node, Pod, ReplicaSet, Deployment, Service, Endpoints, Event, ConfigMap,
Job, CronJob, DaemonSet`. (ConfigMap only as env source for one mission; Job/CronJob/
DaemonSet with core semantics only.)

### 2.2 Engine — kubectl command matrix (MVP)
| Command | Supported in MVP | Notes |
|---|---|---|
| `get` | `TYPE`, `TYPE NAME`, `TYPE/NAME`, `all`, `-n`, `-A`, `-o wide|yaml|json|name|jsonpath`, `-l`, `--show-labels`, `-L`, `--no-headers`, `-w` (basic), `--sort-by` (simple path) | Exact table layout |
| `describe` | pod, deployment, rs, svc, node, job, cronjob, daemonset, cm, ns | Upstream layout incl. Events |
| `apply -f` | file(s), multi-doc, `-n`, `--dry-run=client` | created/configured/unchanged |
| `create` | `-f`, `namespace`, `deployment --image --replicas --port`, `configmap --from-literal`, `job --image`, `cronjob --schedule --image`; `--dry-run=client -o yaml` | |
| `run` | `--image`, `--restart`, `--env`, `--labels`, `--port`, `--command -- …`, `--dry-run=client -o yaml`, `-it --rm -- sh` (busybox-style debug pod) | |
| `delete` | by type/name, `-f`, `-l`, `--all`, `--now`, `--grace-period`, `--cascade=orphan`, `--force` | |
| `scale` | `deployment|rs --replicas` | |
| `rollout` | `status`, `history [--revision]`, `undo [--to-revision]`, `restart`, `pause`, `resume` | |
| `set` | `image`, `env` (literal, `--from=configmap`) | |
| `edit` | pod (limited fields), deployment, svc, cm | opens editor |
| `label`, `annotate` | add/overwrite/remove (`key-`) | |
| `logs` | `-c`, `--previous`, `--tail`, `-f`, `--since`, `-l` | |
| `exec` | `-- cmd`, `-it -- sh` interactive in-container shell | |
| `port-forward` | `POD|svc/NAME LOCAL:REMOTE` (simulated; `curl localhost:LOCAL` works in the game shell) | |
| `expose` | deployment/pod/rs `--port --target-port --type --name` | |
| `cordon`, `uncordon`, `drain` | `--ignore-daemonsets`, `--delete-emptydir-data`, `--force` | |
| `config` | `get-contexts`, `current-context`, `use-context`, `set-context --current --namespace`, `view --minify` | |
| `explain` | top-level kinds + common paths for pod/deployment/service | |
| `api-resources`, `version`, `cluster-info`, `top pod|node` | | |
| `wait` | `--for=condition=Ready|Available`, `--for=delete`, `--timeout` | |

Everything else: honest "not supported" error. Flags not listed: `error: unknown flag`.

### 2.3 Engine — behaviour
- Scheduler (resources, nodeSelector, cordon, taints/tolerations basic, Ready).
- Kubelet: pull (incl. ImagePullBackOff), start, readiness/liveness/startup probes,
  CrashLoopBackOff with real backoff, OOMKilled, graceful termination, restarts.
- ReplicaSet reconciliation, Deployment RollingUpdate/Recreate with exact surge/
  unavailable algorithm, revisions, rollback, restart; DaemonSet basic; Job
  (completions/parallelism/backoffLimit) and CronJob (schedule) basic.
- Endpoints follow readiness; Service ClusterIP/NodePort/LoadBalancer; DNS.
- Events with counts; GC cascade; node NotReady chaos with eviction.
- Traffic sim + SLO window.

### 2.4 Shell
`kubectl`/`k`, `ls cat cd pwd echo clear help history`, `| grep`, `| head/tail/wc`,
`>`/`>>`, `&&`, `vim/vi/nano/edit FILE` → editor, `curl localhost:PORT` after
port-forward, in-container shell (`ls cat env hostname nslookup curl wget exit`).

### 2.5 Game
- Mission runtime: objectives, chaos (`nodeDown/nodeUp`, `killPods`, `badImagePush`,
  `trafficSpike`), hints with star cost, timer, par time, score, stars.
- Briefing (ticket + concept cards) and debrief (score breakdown, pro tips, commands used).
- Campaign map screen with chapter/mission cards, lock/unlock by stars; Sandbox mode
  (one preset cluster). Challenge mode: **out** (post-MVP).
- Progress persisted (Electron: `data/progress.json`; browser: `localStorage`).

### 2.6 UI
Top bar, cluster map (nodes, pods, workload groups, services, animated traffic,
event toasts), side panel (Ticket / Objectives / Concepts / Hints), terminal with
history and Tab completion, YAML editor, settings (sound off by default in MVP,
reduced motion, font size).

### 2.7 Missions (13; ★ = must-ship for MVP, ◇ = ship if time allows)
| # | Chapter | Title | Teaches | Stakes |
|---|---|---|---|---|
| ★ 0.1 | 0 | Welcome aboard | map, terminal, `get nodes/pods -A`, `describe` | tutorial, 3 min |
| ★ 1.1 | 1 | The image that wasn't | image tags, registries, `ImagePullBackOff`, why orchestration (cards) | timer |
| ★ 2.1 | 2 | Where is everything? | namespaces, `-n/-A`, `-o wide`, labels/selectors, contexts | find & label the sick pod, timer |
| ★ 2.2 | 2 | Logs don't lie | `logs`, `--previous`, `describe` events, env vars, `edit`/apply fix | crashloop incident |
| ★ 2.3 | 2 | Declarative by Friday | `run`, `--dry-run=client -o yaml >`, `apply`, drift, `delete -f` | par commands |
| ◇ 2.4 | 2 | Inside the box | `exec`, `port-forward`, `cp`-less debugging, in-container `curl` | timer |
| ★ 3.1 | 3 | Three of a kind | ReplicaSets, reconciliation, `scale`, deleting pods under traffic | SLO |
| ★ 3.2 | 3 | Ship it (and un-ship it) | Deployments, `set image`, `rollout status/history/undo`, bad tag chaos | SLO + timer |
| ★ 3.3 | 3 | Probe-ably fine | readiness vs liveness vs startup probes, endpoints gating | SLO during rollout |
| ★ 3.4 | 3 | Out of memory | requests/limits, OOMKilled, Pending/Insufficient memory, QoS | SLO + timer |
| ◇ 3.5 | 3 | Night shift | Jobs (parallelism/completions/backoff), CronJob, DaemonSet on node join | par |
| ★ 3.6 | 3 | Capstone: Zero-downtime Friday | multi-tier app, probes+limits, rollout+rollback, node failure chaos | SLO + timer |
| ★ 4.1 | 4 | Nobody's home | Services, selectors vs labels (all entries must match; replace stale keys), endpoints, DNS from inside a pod | SLO |
| ◇ 4.2 | 4 | Open to the world | `expose`, port vs targetPort, NodePort/LoadBalancer | timer |

Every mission ships with a `solution` script and a solvability test.

## 3. Out of scope for MVP (explicitly deferred)
StatefulSet, PV/PVC/StorageClass, Secrets beyond basics, RBAC, SecurityContext/PSA,
NetworkPolicy, Ingress/Gateway, HPA/PDB/Quota, Helm/Kustomize, CRDs, multi-cluster
contexts, Challenge mode, sound, packaging installers (`@electron/packager` scripted
but not required), real-cluster backend, localisation, `-k`, `patch`, `diff`,
`custom-columns`, `--field-selector`.

## 4. Narrowings relative to the Tech Spec
- `describe` output for kinds other than Pod/Deployment/Service/Node may omit rarely
  used sections (documented in code with `// TODO(fidelity)`).
- `get -w` prints the current table then appended rows on change; no `--output-watch-events`.
- Backoff cap and probe timers are real; missions use images with fast start/stop.
- Only one kubeconfig context (`kubequest`) in MVP; `config` commands still work.

## 5. Acceptance criteria (definition of done)
1. `npm install && npm run check` passes (typecheck + all tests, incl. every mission's
   solution) on Node 24, Linux.
2. `npm start` opens the desktop window; `npm run web` serves and opens the browser
   build; both play mission 0.1 → 3.2 end to end.
3. All ★ missions playable with briefing, objectives, debrief, stars, persistence.
4. Golden-output tests for `get pods|deploy|rs|svc|nodes|ns|events`, `describe pod`,
   `rollout status/history`, common errors.
5. Nothing is written outside the project folder during dev or play (verified by
   listing `~/.npm`, `~/.cache/electron`, `~/.config` before/after).
6. Idle CPU < 3 % in a paused mission; 60 fps map with 40 pods on integrated graphics
   (visual check).

## 6. Demo script (what to show)
1. Launch → campaign screen → 0.1 tutorial (map lights up on `kubectl get pods -A`).
2. 2.2: pod crash-looping, `logs --previous` reveals missing `CARGO_DB_URL`, `edit`
   the manifest, apply, watch it go green.
3. 3.2: set a new image under traffic; SLO stays green; chaos pushes a bad tag;
   pods go red; `rollout undo`; debrief shows 3 stars.
4. 4.1: service with no endpoints; `exec` into a pod, `nslookup`/`curl` fails;
   fix selector; packets start flowing on the map.

## 7. Build order (implementation plan)
1. Scaffold: `package.json`, `tsconfig`, esbuild scripts, `AGENTS.md`, `ARCHITECTURE.md`.
2. Engine core: clock/rng/store/registry/yaml/duration/printers/validation.
3. Controllers: scheduler, kubelet, RS, Deployment, endpoints/service, GC, node.
4. kubectl: parser + `get/describe/apply/create/run/delete/scale/rollout/set/label/
   logs/exec/expose/config/…` + shell + VFS + in-container shell.
5. Game layer: mission DSL, runtime, scoring, progress, storage.
6. Missions 0.1, 2.1, 2.2, 2.3, 3.1, 3.2 (+ tests), then 3.3, 3.4, 3.6, 4.1, 1.1, then ◇.
7. UI: layout, terminal, map renderer, panels, editor, briefing/debrief, campaign.
8. Desktop shell + web fallback; README; footprint verification.

## 8. Risks specific to the MVP
- Simulator fidelity work can swallow the schedule → implement commands in the order
  missions need them; golden tests for the top-10 outputs only.
- Canvas map clarity → cap missions at 3 nodes / 30 pods; iterate visuals last.

## 9. Revision log
- v1.0 — 8 missions, no traffic sim.
- v1.1 — Added traffic/SLO to the MVP after PRD pillar-1 review ("it's a game");
  added 4.1 because services + endpoints are the most common real incident.
- v1.2 — Marked ★/◇; added capstone 3.6; moved Challenge mode out; added demo script
  and footprint acceptance check.

## 9b. Post-MVP additions
- 2026-10-06: Pause/Restart controls; full-height side panel layout.
- 2026-10-07: Briefing **lessons** (≤5 paragraphs per mission) tying concept cards to the ticket; content-rule test.
- 2026-10-07: Per-objective **insights** (senior-engineer commentary unlocked on completion) in a new Insights tab.

## 10. Delivery status (2026-10-06)

| Acceptance criterion (§5) | Status |
|---|---|
| 1. `npm install && npm run check` green | ✅ 31 tests (YAML, controllers, kubectl end-to-end, 14 mission solutions) + strict typecheck |
| 2. `npm start` desktop window; `npm run web` browser build | ✅ Electron verified headlessly via `KQ_SMOKE` screenshot; web server verified with curl + headless Chrome screenshots |
| 3. All ★ missions playable with briefing/objectives/debrief/stars/persistence | ✅ 11 ★ + 3 ◇ missions shipped (0.1, 1.1, 2.1–2.4, 3.1–3.6, 4.1–4.2) |
| 4. Golden-output tests for core tables/describe/rollout/errors | ✅ in `tests/engine/kubectl.test.ts` |
| 5. Nothing written outside the project folder | ✅ `npm run footprint` clean; Electron userData redirected to `./data/electron` |
| 6. Idle CPU / 60 fps | ◻ not measured on target hardware; loop is fixed-step with no work while no mission is open |

Known narrowings beyond §4: `describe` for Job/CronJob/DaemonSet is abridged; `get -w` prints
changed rows without `--output-watch-events`; Chrome/Electron sandbox fallback on Linux hosts that
restrict user namespaces is automatic (`scripts/start.mjs`).
