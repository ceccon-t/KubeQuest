# AGENTS.md — working agreement for humans and AI agents on Kubequest

This file is the contract every contributor (human or AI) follows. It is enforced in
code review and by `npm run check`. Read `ARCHITECTURE.md` before touching code and
`docs/MVP_SCOPE.md` before adding features.

## 1. Non-negotiables
1. **Correctness over cleverness.** Any `kubectl` behaviour we implement must match
   real Kubernetes (v1.31–1.33): command names, flags, output layout, error strings,
   controller semantics. If unsure, *do not guess* — implement the honest
   "not supported" path (`engine/kubectl/unsupported.ts`) and open a `TODO(fidelity)`.
   A bug that teaches the player something wrong is **P0**.
2. **Zero runtime dependencies.** `dependencies` in `package.json` stays empty.
   Dev dependencies are limited to `typescript`, `esbuild`, `electron`, `@types/node`
   (+ optional `@electron/packager`). Adding one requires a written justification
   in the PR and an update to `docs/TECH_SPEC.md §1`.
3. **Nothing outside the project folder.** Caches (`.cache/`), builds (`dist/`),
   player data (`data/`) live here. Never write to `~`, `/tmp` or OS app-data dirs.
   `npm run footprint` must report clean.
4. **Engine is pure.** `src/engine` has no DOM, no timers, no `Math.random`, no
   `Date.now()`. Time comes from `Clock`, randomness from `Rng`. This keeps missions
   deterministic and tests fast.
5. **Dependency direction:** `engine ← game ← ui`; `missions` depend on `game`
   types only; `desktop` depends on nothing in `src/` (loads the bundle).
6. **Every mission ships with a `solution` and passes its solvability test.**
7. **Strict TypeScript.** No `any` (use `unknown` + narrowing), no `!` non-null
   assertions except in tests, no `// @ts-ignore`. `npm run typecheck` is clean.
8. **Erasable TypeScript syntax only** (Node runs `.ts` in strip-only mode): no
   `enum`, no `namespace`, no constructor parameter properties (`constructor(public x)`),
   no decorators. Use `const` objects + union types instead of enums.

## 2. Workflow
- Before coding: find the feature in `docs/MVP_SCOPE.md` (or add it there if it is
  post-MVP work). Keep the scope line and the code change in the same PR.
- Write/extend tests first for engine behaviour (`tests/engine/*.test.ts`), golden
  output (`tests/golden/`), and missions (`tests/missions/*.test.ts`).
- Run `npm run check` before every commit. Keep it green.
- Update `ARCHITECTURE.md` whenever you add a module, a controller, a command or an
  extension point. Stale architecture docs are a bug.
- Commit messages: `area: imperative summary` (`engine: add DaemonSet controller`).

## 3. Code style
- ES modules, `.ts` extension in relative imports (Node native TS + esbuild agree).
- Small modules with one responsibility; prefer pure functions over classes except
  for stateful subsystems (`Engine`, `ClusterStore`, `Shell`).
- Names mirror Kubernetes vocabulary exactly (`replicaSet`, `podTemplateHash`,
  `maxUnavailable`), never game slang in engine code.
- Output strings that mirror `kubectl` are built in `printers/` and `describe/`
  only; commands never format tables by hand.
- Errors: throw `KubectlError(message, exitCode)`; the shell prints it. Messages are
  copied verbatim from upstream where they exist.
- UI: no inline styles in TS except for computed geometry; colours via CSS variables
  in `web/styles.css`; all status colours have a shape/label counterpart.
- Comments explain *why*, and cite upstream behaviour when non-obvious
  (e.g. `// upstream: pkg/controller/deployment/rolling.go`).

## 4. Testing rules
- `node --test`; tests import `.ts` sources directly. No mocks of the engine — use
  a real `Engine` with a seed and `engine.advance(seconds)`.
- Golden files are captured from real `kubectl` output, hand-adjusted only for
  names/ages. Note the kubectl version at the top of each golden file.
- A controller change must include a scenario test that would have failed before.

## 5. Content rules (missions)
- A mission is a *ticket* with stakes. If it has no timer, no traffic and no chaos it
  must be ≤ 3 minutes and labelled "tutorial".
- Every mission has a **lesson** (`src/missions/lessons.ts`): 2–5 paragraphs, ≤130 words
  each, in the mentor's voice, that tie the concepts to *this* ticket — what is happening,
  which tool, how to use it, when it matters elsewhere. It is read before the ticket is
  taken, so it must be short. Enforced by `tests/missions/content.test.ts`.
- Most objectives carry an **insight** (`src/missions/insights.ts`, ≤90 words): what a senior
  engineer pairing with the player notices once that objective is done, and where they would look
  next. Insights guide attention; they never state the answer to a later objective.
- Concept cards ≤ 120 words, one idea each, with a runnable example; they are reference
  material (collapsed in the briefing, listed in the Concepts tab), not the lesson.
- Hints go from vague to exact; the last hint is the command.
- Never invent Kubernetes behaviour for drama. Drama comes from realistic failure
  modes (bad tags, missing env, wrong selectors, tight limits, node loss).

## 6. Performance & resources
- Tick ≤ 1 ms at 100 pods; render ≤ 4 ms/frame. No work while paused.
- Bundle ≤ 600 KB. Check with `npm run build` (sizes printed).

## 7. Definition of done for a PR
Scope line referenced · tests added · `npm run check` green · `ARCHITECTURE.md`
updated if structure changed · no new deps · footprint clean.
