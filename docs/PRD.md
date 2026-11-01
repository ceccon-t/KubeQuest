# Kubequest — Product Requirements Document (PRD)

**Status:** v1.2 (self-iterated; see §12 for revision log)
**Owner:** Tiago (product) / Claude (author)
**Feeds into:** `docs/TECH_SPEC.md` (how), `docs/MVP_SCOPE.md` (what first)

---

## 1. Vision

Kubequest is a desktop game in which the player keeps a fictional company's Kubernetes
clusters alive by typing **real `kubectl` commands and real YAML** into an in-game
terminal while a living, animated cluster reacts in real time. It is a game first:
there are incidents, timers, traffic to keep flowing, scores, stars, and a campaign
with a story. It is a course second: the campaign follows the "Kubernetes Mastery"
curriculum (`curriculum-full.md`) stage by stage, and everything the player learns
transfers 1:1 to a real cluster because the commands, flags, output formats, object
schemas and controller behaviour are faithful to Kubernetes.

> One-liner: *"Pager goes off. Pods are crash-looping. Traffic is dropping. You have
> `kubectl` and three minutes."*

## 2. Problem & Opportunity

- Kubernetes is learned mostly by reading docs and copy-pasting commands into a
  cluster one has to install first. That setup cost (Docker, kind/minikube, multi-GB
  images) stops many learners before they type a single command.
- Existing "learn Kubernetes" tooling is either passive (videos, quizzes) or a sandbox
  with no goals, feedback loop or sense of progress.
- A game provides goals, immediate feedback, escalating challenge and a reason to come
  back — but only if the practice inside it is *correct*. A game that teaches wrong
  habits is worse than none.

**Opportunity:** a self-contained, zero-setup game whose "sandbox" is a faithful
simulated cluster, so the player practices the real tool against realistic failure
modes, and whose fun comes from the drama of operating production.

## 3. Target Players

| Persona | Background | What they want | Design implication |
|---|---|---|---|
| **The Newcomer** | Comfortable with Linux CLI; never used K8s | Mental model + confidence with `kubectl` | Early missions scaffold heavily; concept cards; forgiving hints |
| **The Dev on a K8s team** | Deploys via CI, rarely touches `kubectl` | Be able to debug their own app when paged | Incident missions; debugging flow (`describe`/`logs`/`events`) emphasised |
| **The Cert Candidate** | Studying CKA/CKAD | Speed & accuracy under time pressure | Timed missions, par times, no-hint runs, command accuracy stats |
| **The Returning Expert** | Knows K8s, wants fun | A challenge mode | Chaos mode, hard incidents, leaderboard-style personal bests (local) |

Prerequisites assumed (from curriculum): Linux CLI, basic networking. No prior
container/K8s experience assumed.

## 4. Design Pillars

1. **It must be fun before it is educational.** Every mission has stakes (traffic,
   a timer, a score), a visible, animated consequence for every command, and a
   satisfying "it's green" moment. If a mission is only a checklist, it is cut.
2. **Correctness is non-negotiable.** Any command the game accepts must behave as it
   does in Kubernetes (output shape, flags, error messages, controller behaviour).
   Anything unsupported fails *loudly and honestly* ("not supported in Kubequest yet")
   rather than pretending. No invented flags, no fake resources.
3. **Zero setup, zero footprint.** No Docker, no cluster, no admin rights. One folder.
   Delete the folder → nothing is left behind.
4. **Show, don't tell.** The cluster map *is* the teaching device: reconciliation,
   rollouts, readiness gating traffic, scheduling — all visible as animation.
   Text explanations are short, optional, and arrive at the moment of relevance.
5. **Respect the player's time and machine.** Fast launch, low CPU/RAM, missions
   of 3–10 minutes, resumable progress.

## 5. Core Experience

### 5.1 The fantasy
You are the newest on-call engineer at **Orbital Logistics**, a (fictional) company
that schedules freight between space ports. Their platform runs on Kubernetes and
it is… not in great shape. Each mission is a **ticket** from the on-call queue:
an onboarding task, a feature rollout, or a pager-screaming incident. Your manager
(a dry, slightly sarcastic Chief Helmsman) briefs you, and the platform's SLO board
judges you.

### 5.2 The core loop (one mission)
1. **Briefing** — a short story beat + the ticket's objectives + 1–3 *concept cards*
   (optional reading, each ≤120 words, with a "try it" example).
2. **Play** — the cluster map comes alive. The player types commands in the terminal;
   the map animates the consequences (pods spawning, dying, rolling, traffic flowing
   or dropping). Objectives tick off live. Chaos events may fire (node dies, traffic
   spike, bad image pushed by "a colleague").
3. **Debrief** — score, stars (1–3), what was done well, a "pro tip" (e.g. the shorter
   flag they could have used), and the commands used, so the player can review.

### 5.3 What makes it a game
- **Stakes:** a live **SLO meter** (served vs. dropped requests) on missions that
  carry traffic; drops cost score. Some tickets have a **timer** (incident SLA).
- **Score & stars:** objectives (base), speed (par time), efficiency (fewer wasted
  commands), no-hint bonus, zero-downtime bonus. 3 stars = "senior" performance.
- **Chaos:** scripted or random events force reaction, not just execution.
- **Progression:** stages unlock by stars; a **Challenge mode** remixes missions with
  randomised failures; a **Sandbox** lets the player free-play on any cluster layout.
- **Juice:** animated map, packets of traffic, pod state glows, subtle sound cues
  (toggleable), terminal with autocompletion and colour.

### 5.4 Teaching model
- **Learn by doing, in context.** Concept cards are tied to the moment they are needed.
- **Guided → independent.** Early missions give the exact next command on request;
  later ones give only direction ("something is wrong with the readiness probe");
  expert missions give nothing.
- **Hints are a currency.** Each hint lowers the star ceiling; the player decides.
- **Errors are faithful.** A typo produces the same error `kubectl` prints. The
  game adds a one-line gentle nudge *below* the real error, never instead of it.
- **Declarative first.** Imperative commands are taught, then the game steers to
  `apply -f` and shows why (drift, repeatability) — mirroring the curriculum.
- **Explain command** (`kubectl explain`) works, and a `help` built-in lists what the
  simulator supports.

## 6. Content: Campaign Structure

The campaign mirrors the curriculum's stages. Each stage is a "chapter" of tickets
ending in a **capstone mission** that mirrors the curriculum capstone.

| Chapter | Curriculum stage | Ticket flavour | Example tickets |
|---|---|---|---|
| 0 Orientation | — | Tutorial | Meet the terminal, the map, `kubectl get` |
| 1 Foundations | Stage 1 | Briefing-heavy, light play | Image tags & pulls, `ImagePullBackOff`, registry, why orchestration |
| 2 Hands-On | Stage 2 | Fluency drills | Namespaces & contexts, `get/describe`, output formats, labels, `logs/exec/port-forward`, declarative vs imperative |
| 3 Workloads | Stage 3 | Deploy & incident | Pods, probes, limits/QoS, ReplicaSets, Deployments (rollout/rollback/strategies), DaemonSets, Jobs/CronJobs, `kubectl debug` |
| 4 Networking | Stage 4 | Expose & segment | Services (ClusterIP/NodePort/LB), DNS, EndpointSlices, Ingress/Gateway, NetworkPolicy |
| 5 Config/State/Security | Stage 5 | Harden | ConfigMaps/Secrets, PV/PVC/StorageClass, StatefulSets, RBAC, SecurityContext, PSA |
| 6 Production | Stage 6 | Keep it alive | Scheduling (affinity/taints/spread), HPA, PDB & drains, quotas |
| 7 Platform | Stage 7 | Build the platform | Kustomize, Helm, GitOps, CRDs & operators |
| 8 Specialisation | Stage 8 | Optional challenge packs | GPU/DRA, chaos, multi-tenancy |

Topics that cannot be exercised faithfully in a simulator (e.g. writing Dockerfiles,
installing Cilium, real eBPF) are delivered as **briefings with interactive quizzes**
and a clearly-labelled "in the real world you would…" card, never as fake commands.

## 7. Functional Requirements

### FR-1 Terminal
- Accepts `kubectl` commands with faithful parsing of subcommands, flags (long & short),
  resource type aliases (`po`, `deploy`, `rs`, `svc`, …), `type/name` and `type name` forms.
- Shell conveniences: history (↑/↓), Tab completion (commands, resource types,
  names, flags), `clear`, `ls`/`cat` on a mission-provided virtual filesystem,
  `k` alias, `alias`, piping to `grep` for the commonest flows (`| grep`), `watch`-like `-w`.
- An in-game **YAML editor** opened by `kubectl edit`, `vim`/`nano`/`edit <file>`, with
  validation errors shown faithfully on apply.

### FR-2 Cluster simulation
- Multi-node cluster with control-plane behaviour: scheduler, Deployment/ReplicaSet/
  DaemonSet/Job/CronJob/StatefulSet controllers, endpoints controller, kubelet
  (probes, restarts, backoff), node lifecycle, events, resource accounting.
- Image catalogue: fictional images with defined behaviours (start time, crash
  conditions, env/config requirements, memory usage, log lines, probe endpoints).
- Traffic generator per Service with SLO accounting.
- Deterministic under a seed (for reproducible missions and tests).

### FR-3 Missions
- Declarative mission definition: initial cluster state, files, objectives
  (predicates on cluster state / command history), chaos timeline, hints, concept
  cards, par time, scoring weights.
- Live objective tracking, debrief with score and stars, persistence of progress.

### FR-4 Visualisation
- Cluster map: nodes, pods (phase/ready/restarts), workloads grouping, services and
  traffic flow, namespaces filter. Smooth animation at 60 fps on integrated graphics.
- Inspect-on-hover (never required to play; keyboard-only play must be possible).

### FR-5 Modes
- Campaign (chapters/tickets), Challenge (remix with random chaos & seed), Sandbox.

### FR-6 Player profile
- Local-only progress, settings (sound, reduced motion, font size), stats
  (commands typed, accuracy, best times). Export/import as JSON.

## 8. Non-Functional Requirements (constraints from the brief)

| Requirement | Target |
|---|---|
| Cross-platform | Linux, macOS, Windows (x64/arm64) |
| Distribution | Downloadable archive or installer; also runnable from source with `npm install && npm start` |
| Footprint | No files written outside the app's own folder (portable mode); uninstall = delete folder |
| Dependencies (player) | None beyond the shipped app. Browser fallback needs only a modern browser |
| Dependencies (dev) | Node ≥ 22 and npm only; all packages local to the project folder |
| Runtime resources | < 300 MB RAM, idle CPU < 3 %, launch < 3 s |
| Offline | Fully offline |
| Accessibility | Keyboard-only play, reduced-motion option, colour-blind-safe status palette, resizable text |
| Privacy | No telemetry, no network calls |

## 9. Success Metrics (how we'll know it works)

- **Fun:** a tester voluntarily plays a second mission without being asked; median
  mission completion rate ≥ 80 % in chapters 0–3.
- **Transfer:** after chapters 2–3, a player can complete the Stage 3 curriculum
  capstone on a real kind cluster using only what they practised.
- **Correctness:** 0 known divergences from `kubectl` behaviour for supported commands
  (tracked as bugs with severity "teaches a wrong thing" = P0).
- **Footprint:** verified clean uninstall on all three OSes.

## 10. Out of Scope (product-level)

- Running against a real cluster (planned extension; architecture must allow it).
- Multiplayer, accounts, cloud sync, leaderboards beyond local.
- Mobile.
- Simulating Docker image builds (taught via briefing + quiz).

## 11. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Simulator drifts from real K8s → teaches wrong things | Correctness pillar; golden tests against recorded real `kubectl` output; "unsupported" honesty; faithful error strings |
| Simulator scope explodes | Strict command matrix per chapter (Tech Spec); unsupported = honest error |
| "Checklist with a terminal" instead of a game | Every mission must carry stakes (traffic/timer/chaos) or be a ≤3-minute tutorial; pillar 1 review gate |
| Visual map becomes noise at scale | Namespace/workload filters; clusters in missions kept ≤ 6 nodes / ≤ 60 pods |
| Electron footprint/size | Portable mode; browser fallback; one shell layer only |

## 12. Revision log (self-iteration)

- **v1.0** — first draft: "learning platform with a terminal".
- **v1.1** — rewrote §5 after pillar review: added stakes (SLO meter, timers, chaos),
  stars and hint currency; cut "lesson pages" in favour of concept cards at the point
  of need; added "faithful errors with gentle nudge" rule.
- **v1.2** — decided simulated cluster over real local cluster (footprint & setup
  pillars); added honesty rule for unsupported commands; added quiz/briefing path for
  non-simulable topics; added accessibility and privacy NFRs; clarified persona-driven
  requirements (timed/no-hint runs for cert candidates).
