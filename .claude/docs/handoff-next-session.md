# Handoff — ralphctl next session

**Read this first, in full, before writing any code.** The previous session ran long,
over-scoped, and left the UI experience half-baked relative to the user's vision.
This doc is the checkpoint so a fresh session can finish the work cleanly.

## TL;DR for the next Claude

- The **code-side pipeline refactor is done and tested** (refine / plan / ideate /
  evaluate / execute all run through `src/business/pipelines/*` with the framework
  in `src/business/pipeline/`). 1310 tests pass. `pnpm typecheck && pnpm lint &&
pnpm test` is green.
- The **TUI side is the real gap**. User's mental model: the pipeline should BE the
  UI spine. Home should show the sprint lifecycle as phases; each phase should be
  drillable into a live view. Today Home is a categorical menu and most commands
  still dump plain text into the scrollback. That disconnect is the thing that
  makes the user feel the work "failed."
- **There are eight commits of work ahead**, grouped into two priorities. Priority 1
  (the UI pipeline map + phase views + live streaming) is what the user sees first
  and matters most. Priority 2 (five target-seq items) polishes the already-working
  execution path.
- The user is tired. They do not want another big architectural conversation. They
  want to see the UI vision realised. Execute the plan below. Ask only when blocked.

## 1. Current State

### Git

Branch: `feature/misc`. Last 14 commits (newest first):

```
73b5f3e  feat(tui): add Dashboard as a navigation destination
3471800  refactor(tui): introduce view router with navigation stack
ddfd246  fix(tui): handle Enter on pre-selected default in SelectPrompt
e8abc8a  refactor(pipeline): replace executor inner loop with forEachTask
7a83886  refactor(pipeline): introduce PerTaskPipeline with nested evaluator
f33f90c  feat(pipeline): add forEachTask primitive for dynamic-queue scheduling
8b93583  docs(pipeline): reflect adoption in CLAUDE.md + ARCHITECTURE + REQUIREMENTS
3ef64cb  chore(lint): enforce CLI/TUI → pipelines boundary
acea275  refactor(pipeline): migrate Execute use case to pipeline
978a4cf  refactor(pipeline): migrate Evaluator use case to pipeline
9f33eca  refactor(pipeline): migrate Ideate use case to pipeline
04105f0  refactor(pipeline): migrate Plan use case to pipeline
01991dc  refactor(pipeline): migrate Refine use case to pipeline
27e940d  feat(pipeline): add nested/parallelMap primitives + shared steps
```

### Uncommitted / stashed work

One stash exists:

```
stash@{0}  "session-id-wiring-paused" — On feature/misc
```

This is the implementation of target-seq item "session-id resume wiring" (forEachTask's
retry policy captures `sessionId` on rate-limit, but today the next launch doesn't use
`--resume`). It's fully implemented and was green before being stashed. Recover with
`git stash pop stash@{0}` when you get to commit E below.

### Working app state

- `pnpm dev` launches the TUI. It doesn't crash. The user's complaint is not
  "broken" — it's "doesn't feel like the web-app-style experience I expected."
- All CLI commands work (plain-text mode) and all pipelines run.
- Dashboard view exists (hotkey `d`). Settings view exists (hotkey `s`). Home is a
  menu. That's it — no phase-centric navigation, no detail views, no live streams
  outside of `sprint start`.

## 2. The Vision — pipeline as UI spine

The user wants **Home = pipeline map**:

```
┌─────────────────────────────────────────────────────────────────┐
│  ralphctl  •  Sprint: "dashboard rewrite"  [draft]              │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│   1. Refine         ✓  4/4 tickets approved                     │
│   2. Plan           ✓  12 tasks generated                       │
│   3. Execute        ⚙  7/12 done · 2 running · rate-limited     │
│   4. Close          ○  pending                                  │
│                                                                 │
│   ↑↓ navigate · Enter drill in · d dashboard · s settings       │
└─────────────────────────────────────────────────────────────────┘
```

Each phase is drillable → a **phase detail view**:

- **RefinePhaseView** — ticket list with approval status; "Refine next pending" action;
  lower pane streams AI output when a session is running.
- **PlanPhaseView** — repo selection; AI exploration log streaming; task table fills
  in as tasks are generated.
- **ExecutePhaseView** — this is the existing `ExecuteView` with task grid + log tail.
  It's already right; just needs to be reachable as a phase destination.
- **ClosePhaseView** — summary; close action; PR creation option.

Key enablers that already exist in code:

- `executePipeline(...)` returns `StepExecutionRecord[]` that can be rendered as the
  "steps completed in this phase" trace.
- `SignalBusPort` (`InMemorySignalBus`) already emits lifecycle events + harness
  signals. Phase views subscribe via `logEventBus` + `SignalBus`. See
  `src/integration/ui/tui/runtime/event-bus.ts` and the existing `<LogTail />` /
  `useSignalEvents()` hook for the pattern.
- `src/business/pipelines/{refine,plan,ideate,evaluate,execute}.ts` give you the
  canonical phase definitions. Don't invent new phase shapes — read these.

## 3. Roadmap — 8 commits

Execute in this order unless the user redirects.

### Priority 1 — Pipeline-Map UI (3 commits)

These three commits close the "doesn't feel right" complaint. Ship them first.

#### Commit A — Home = Pipeline Map

Replace the current categorical menu in `src/integration/ui/tui/views/home-view.tsx`
with a linear phase visualisation:

```
[1] Refine    [status]  [ticket progress]
[2] Plan      [status]  [task count]
[3] Execute   [status]  [done/in-progress]
[4] Close     [status]
```

- Use `currentSprintStatus` + ticket/task counts to derive phase status. Pattern:
  - Refine status = `allRequirementsApproved` ? ✓ : pending count
  - Plan status = tasks exist ? ✓ : pending
  - Execute status = one of pending / running / done based on tasks.done vs total
  - Close status = sprint.status === 'closed' ? ✓ : pending
- "Current" phase (first non-done) gets highlight + "Next action" hint pre-selected.
- Arrow keys move between phases; Enter drills in. For THIS commit, Enter on a phase
  keeps the existing submenu-launching behaviour as a stopgap (so nothing regresses).
  Commit B replaces the stopgaps with real phase views.
- Keep the `<SprintSummaryLine />` at top; drop the old action-menu categorical
  groupings (PLAN / EXECUTE / BROWSE / SETUP / SESSION).
- BROWSE (sprints/tickets/tasks/projects) and SETUP (configuration/doctor) move
  out of the main home into either: (a) router destinations reachable via hotkeys
  like `b`/`p`, or (b) a secondary menu at the bottom of home ("more…"). Either is
  fine — user hasn't expressed a strong preference; pick the simpler one.

**Test requirements**:

- `home-view.test.tsx` asserts the five phases render in order with correct statuses
  for draft / active / closed fixture sprints.
- Navigation test: arrow-key cycles phases, Enter dispatches.

Expected commit message:
`feat(tui): pipeline map as Home — phases visible with status + progress`

#### Commit B — Phase detail views (static)

Add four new views + register in the router:

- `src/integration/ui/tui/views/phases/refine-phase-view.tsx`
- `src/integration/ui/tui/views/phases/plan-phase-view.tsx`
- `src/integration/ui/tui/views/phases/execute-phase-view.tsx` — thin wrapper over the
  existing `ExecuteView` component, or just route `'execute-phase'` to `ExecuteView`.
- `src/integration/ui/tui/views/phases/close-phase-view.tsx`

For this commit, each view is **static** — no live streaming yet. Render:

- **RefinePhaseView**: ticket table (id, title, status badge), "Refine next" action
  button that invokes `createRefinePipeline(...)` via `executePipeline`, result panel
  showing last run's `StepExecutionRecord[]`.
- **PlanPhaseView**: current tasks table, "Plan" / "Re-plan" action, last run's steps.
- **ExecutePhaseView**: already right (task grid + log tail). Just reachable now.
- **ClosePhaseView**: task completion summary, "Close sprint" action, "Create PR"
  option if branch set.

Register `'refine-phase'`, `'plan-phase'`, `'execute-phase'`, `'close-phase'` in
`ViewId` and the router map. Home's Enter now pushes the right phase view.

**Test requirements**:

- One render test per view with a fixture sprint.
- Router test that Home's Enter on phase N pushes the correct ViewId.

Expected commit message:
`feat(tui): add per-phase detail views reachable from Home pipeline map`

#### Commit C — Live streaming into phase views

Subscribe phase views to `SignalBusPort` + `logEventBus`. While any pipeline is
running, the phase view shows live output:

- RefinePhaseView: when `createRefinePipeline` is running, the lower pane shows
  AI output stream (refine session stdout), current step name from
  `StepExecutionRecord[]` as they settle, progress spinner on the current step.
- PlanPhaseView: same but for plan pipeline. AI exploration shows in lower pane.
- ExecutePhaseView: already has this — confirm it still works through the router.

Key existing patterns to reuse:

- `useSignalEvents()` hook
- `useLoggerEvents()` hook
- `InMemorySignalBus` is already injected via `SharedDeps`

For refine/plan specifically, the AI session's stdout needs to flow through the
logger. Check `src/business/usecases/{refine,plan}.ts` — they call `aiSession.spawnHeadless`
and `aiSession.spawnInteractive`. The session adapter may already emit to the bus;
verify and wire if missing. Don't add new streaming infrastructure if it already
exists under another name.

**Test requirements**:

- Render test with a mocked signal bus emitting events, assert they appear in the
  view's output pane.

Expected commit message:
`feat(tui): live streaming of AI output into refine / plan / execute phase views`

### Priority 2 — Target-seq polish (5 commits)

These close the target-seq.puml TODOs. After these, the aspirational diagram = reality.

#### Commit D — Legacy dead-code purge (small, safe)

Delete:

- `src/integration/ai/executor.ts`
- `src/integration/ai/runner.ts`
- `src/integration/ai/executor.test.ts`
- `src/integration/ai/runner.test.ts` (if exists)

These are ~1400 LOC of closed-loop legacy from before the pipeline adoption.
Unreachable from any runtime caller post-`e8abc8a`. Verify with `pnpm dlx knip`
and `grep -r 'from.*integration/ai/(executor|runner)'` before deletion.

Expected commit message:
`chore: remove legacy ai/executor + runner (unreachable post-pipeline)`

#### Commit E — Session-id resume wiring (pop the stash)

```bash
git stash pop stash@{0}
pnpm typecheck && pnpm lint && pnpm test
git add -A
git commit -m "feat(execute): wire session-id resume into relaunch after rate-limit pause"
```

The implementation is already done. It extends `ExecutionOptions.resumeSessionId`,
threads through `executeOneTask`, and both Claude (`--resume <id>`) + Copilot
(`--resume=<id>`) providers are updated. 1316 tests passed with it applied.

#### Commit F — RateLimitCoordinatorPort layering fix (small)

Today `src/business/pipelines/execute.ts` imports `RateLimitCoordinator` directly
from `src/integration/ai/rate-limiter.ts` — a pre-existing business→integration
violation. Fix by adding a `createRateLimitCoordinator()` factory to `SharedDeps`
in `src/application/shared.ts`; business pipelines call `deps.createRateLimitCoordinator()`.

Port interface already exists: `src/business/ports/rate-limit-coordinator.ts`.

Expected commit message:
`refactor(architecture): move RateLimitCoordinator construction behind SharedDeps factory`

#### Commit G — Plateau detection in evaluator loop

Short-circuit the evaluator loop when critique doesn't change across 2 consecutive
iterations (Anthropic harness-design ceiling-detection pattern). Scope:

- Add `EvaluationStatus = 'passed' | 'failed' | 'malformed' | 'plateau'` to
  `src/domain/models.ts`.
- In `src/business/usecases/evaluate.ts`'s iteration loop, compare the current
  critique's set of failed dimensions against the previous iteration. If identical
  across 2 consecutive rounds, break with status `'plateau'`.
- Update `src/business/pipelines/evaluate.ts` and sidecar format to surface plateau.
- No evaluator prompt changes. The comparator is pure string/set comparison.

Expected commit message:
`feat(evaluate): plateau detection — short-circuit when critique doesn't improve`

#### Commit H — Sprint contract step (biggest of this batch)

Formalise the per-task "contract" between generator and evaluator. Anthropic calls
this pattern essential; we have it implicit via `task.verificationCriteria` today.

- New step `contract-negotiate` before `execute-task` in the PerTaskPipeline.
- Writes `<sprintDir>/contracts/<taskId>.md` combining:
  - Task name + description + steps
  - `verificationCriteria` as a checklist
  - Resolved `checkScript` for the task's projectPath
  - Evaluator dimensions (reuse what's in `task-evaluation.md` prompt)
- Both generator session and evaluator session include the contract path in their
  prompt context.
- Update prompts `task-execution.md` and `task-evaluation.md` to reference the
  contract file. Important: don't break existing prompts — additive only.

Format recommendation: plain-text markdown, structured like a mini README for the
task. Readable by both AI and human.

Expected commit message:
`feat(execute): per-task sprint contract (contracts/<taskId>.md)`

## 4. Explicitly deferred — do NOT attempt

- **`forEachTask` → `forEachItem` rename** — no second use-site exists. Rename only
  if a second site lands.
- **Evaluator calibration via few-shot** — requires product content (example critiques
  that represent the user's standards). Not a code change.
- **Planner dimension emission** — cascading schema change; revisit after plateau
  detection ships.
- **Simplification / reduction of `forEachTask` + `PerTaskPipeline`** — user's
  current stance: "solution is too complicated." You may feel tempted to simplify
  these in the follow-up. **Do not attempt simplification without explicit
  user go-ahead.** Preserving behaviour has already cost ~15 commits; reverting
  would cost more. If the user brings it up, read `ARCHITECTURE.md` Future Work
  and ask before acting.

## 5. Non-negotiables

- **`pnpm typecheck && pnpm lint && pnpm test` green after every commit.** No exceptions.
- **No barrel files.** Direct imports only. Lint fence exists.
- **No behavior change in refine/plan/ideate/execute flows** unless the commit is
  explicitly about that flow. UI commits must not touch use-case or pipeline files.
- **Clean Architecture**: `domain < business < integration < application`. Pipelines
  live in `business`; views in `integration/ui/tui`.
- **Test discipline**: integration test per pipeline asserts step order; lint fence
  prevents CLI/TUI from importing use cases.
- **Commit cadence**: one logical change per commit. User explicitly asked for this
  so they can bail between commits.

## 6. Where to look

| What                                                      | Path                                                                                                     |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Pipeline framework                                        | `src/business/pipeline/{helpers,types,for-each-task}.ts`                                                 |
| Pipeline definitions                                      | `src/business/pipelines/{refine,plan,ideate,evaluate,execute}.ts`                                        |
| Shared steps                                              | `src/business/pipelines/steps/*.ts`                                                                      |
| Per-task steps                                            | `src/business/pipelines/execute/steps/*.ts`                                                              |
| Use cases (delegate holders)                              | `src/business/usecases/{refine,plan,evaluate,execute}.ts`                                                |
| Router + views                                            | `src/integration/ui/tui/views/{view-router,home-view,dashboard-view,settings-view,execute-view,app}.tsx` |
| Router context + hooks                                    | `src/integration/ui/tui/views/router-context.ts`, `runtime/hooks.ts`                                     |
| TUI components                                            | `src/integration/ui/tui/components/*.tsx`                                                                |
| Signal bus                                                | `src/integration/signals/bus.ts`, `src/business/ports/signal-bus.ts`                                     |
| Event bus (UI log stream)                                 | `src/integration/ui/tui/runtime/event-bus.ts`                                                            |
| AI prompts (DO NOT MODIFY unless commit is about prompts) | `src/integration/ai/prompts/*.md`                                                                        |
| Architecture docs                                         | `.claude/docs/ARCHITECTURE.md`, `REQUIREMENTS.md`                                                        |
| Pipeline diagrams                                         | `.claude/docs/seq.puml`, `target-seq.puml`                                                               |

## 7. Useful commands

```bash
pnpm dev                        # Launch TUI for manual testing
pnpm typecheck && pnpm lint && pnpm test   # Full verification
pnpm test path/to/file.test.ts  # Run a single test file
pnpm dlx knip                   # Dead-code scan (for commit D)
git stash list                  # See the session-id-wiring stash
git stash pop stash@{0}         # Recover session-id work for commit E
```

## 8. First message of the next session

Paste this as your opening message to the next Claude session (after pointing it
at this file):

> Read `.claude/docs/handoff-next-session.md` end-to-end before responding. Then
> start with Commit A (Home = Pipeline Map). Confirm the mockup in the handoff
> matches my intent, then execute. No architectural side-quests — the plan is
> written, follow it. Ask only when genuinely blocked.

---

**Open question for fresh session to confirm with user before Commit A**:
Where should BROWSE (sprints / tickets / tasks / projects) and SETUP (config /
doctor) go when Home becomes the pipeline map? Options: (a) router hotkeys like
`b` for browse, `p` for projects; (b) a secondary "more…" menu at the bottom of
Home; (c) keep them inside phase detail views where relevant. Pick one and move.
