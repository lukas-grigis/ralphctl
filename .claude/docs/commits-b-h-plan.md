# Implementation Plan — Commits B–H

> Derived from `.claude/docs/handoff-next-session.md`. Commit A shipped in
> `7d89ada` / `fedf122` / `d6151dd`. This document is the file-level plan the
> next execution pass follows commit-by-commit.

## Executive summary

Commit A shipped Home-as-pipeline-map. The next arc layers drillable phase
views (B), live streaming into them (C), clears out legacy integration/ai
code (D), restores a stashed session-id-resume feature (E), fixes one
business→integration layering violation (F), adds a plateau guard to the
evaluator loop (G), and formalises a per-task sprint contract artifact (H).
B–C are the user-visible arc and hinge on four new router destinations plus
AI stdout → `logEventBus` wiring. D–F are small architectural cleanups. G–H
layer harness-design patterns on top of the working evaluator and per-task
pipeline. Every commit must leave `pnpm typecheck && pnpm lint && pnpm test`
green, ship as one logical change, and avoid backward-compat shims. No
barrel files anywhere.

## Dependency graph

- **A** (shipped) is a prerequisite for **B**: Home dispatches into the new phase views.
- **B** is a prerequisite for **C**: streaming is wired into the views B creates.
- **D** is independent (dead-code purge). Land before F so the grep of `RateLimitCoordinator` importers is smaller.
- **E** is independent (pop stash, commit). No other commit depends on it. Land in order for user pacing.
- **F** should land before **H**: H adds a new per-task pipeline step; touching `execute.ts` after F eliminates churn against the integration-layer import.
- **G** is independent of B–F. Can land any time after A.
- **H** must land after **F** (no strict ordering against G, but prefer F→G→H so the per-task-pipeline diff in H is minimal).
- **E** unblocks nothing downstream; it is purely a restore-and-commit.

Recommended execution order: **B → C → D → E → F → G → H** (matches the handoff).

---

## Commit B — Phase detail views (static)

### Scope

User sees: from Home, arrow-down to phase N and Enter pushes a dedicated
phase view. Four new router destinations render static content (no live
stream yet):

- **RefinePhaseView**: ticket table with approval badges + "Refine next pending" action button + last-run `StepExecutionRecord[]` trace.
- **PlanPhaseView**: current task table + "Plan" / "Re-Plan" action + last-run step trace.
- **ExecutePhaseView**: reachable via phase 3. Re-routes to the existing `execute` destination — no new component.
- **ClosePhaseView**: task completion summary + "Close sprint" action + optional "Create PR" when `sprint.branch` is set.

After this commit the only thing missing is live streaming; the rest of the
phase-detail UX is in place. Home's Enter-on-non-actionable is no longer a
no-op — it pushes the relevant phase view.

### Files to create

- `src/integration/ui/tui/views/phases/refine-phase-view.tsx` — ticket table, approval progress, last-run step trace, action button invoking `createRefinePipeline` via `executePipeline`.
- `src/integration/ui/tui/views/phases/refine-phase-view.test.tsx` — render test with draft/active/closed fixtures; assert ticket table rows + action label.
- `src/integration/ui/tui/views/phases/plan-phase-view.tsx` — current tasks, last-run trace, action button invoking `createPlanPipeline`.
- `src/integration/ui/tui/views/phases/plan-phase-view.test.tsx` — render test.
- `src/integration/ui/tui/views/phases/close-phase-view.tsx` — completion summary + close/PR actions; delegates close to the persistence `closeSprint`, delegates PR to `ExternalPort` if available.
- `src/integration/ui/tui/views/phases/close-phase-view.test.tsx` — render test.
- `src/integration/ui/tui/views/phases/phase-run-trace.tsx` — small shared component rendering `StepExecutionRecord[]` (step name + ok/error glyph + duration). Used by refine/plan/close.
- `src/integration/ui/tui/views/phases/phase-run-trace.test.tsx` — render test.

**No `index.ts` barrel** in `phases/` — every import uses the direct module path.

### Files to modify

- `src/integration/ui/tui/views/router-context.ts` — extend `ViewId` to `'home' | 'settings' | 'execute' | 'dashboard' | 'refine-phase' | 'plan-phase' | 'close-phase'`. **Do not** add `'execute-phase'` — see architectural note.
- `src/integration/ui/tui/views/view-router.tsx` — register three new entries in the `views` registry.
- `src/integration/ui/tui/views/home-view.tsx` — rework `onPipelineAction`. Two paths:
  - Actionable phase → dispatch via `commandMap` (preserves one-shot feel).
  - Non-actionable phase → `router.push({ id: 'refine-phase' | 'plan-phase' | 'execute' | 'close-phase' })`.
  - The dispatch uses `phase.id` (not action group/sub) for the mapping. Phase 3 maps to `'execute'`, not `'execute-phase'`.
- `src/integration/ui/tui/components/pipeline-map.tsx` — split `onSelect` into `onAction` + `onDrillIn` (or pass a union). Enter on actionable row fires `onAction`; Enter on non-actionable row fires `onDrillIn(phase.id)`.
- `src/integration/ui/tui/views/home-view.test.tsx` — update `routerStub.push` expectations for the new drill-in paths.

### Architectural notes

- **ExecutePhaseView decision**: route phase 3 to the existing `'execute'` ViewId. `ExecuteView` already has everything the handoff calls out for this view (task grid, log tail, rate-limit banner, live SignalBus subscription). An `'execute-phase'` wrapper would either duplicate state-loading or be a pass-through. Home's phase-3 drill-in therefore pushes `{id:'execute', props:{sprintId}}` when the sprint is active; for draft sprints where execution hasn't begun, stay on `commandMap` dispatch for `sprint start`.
- **No new ports, no new SharedDeps entries.** Phase views re-use `createRefinePipeline` / `createPlanPipeline` from `src/application/factories.ts` via `getSharedDeps()` (same pattern `ExecuteView` uses).
- `StepExecutionRecord[]` is local React state set by the effect that runs `executePipeline(...)` — read from `result.value.stepResults`.
- Phase views MUST NOT import from `src/business/usecases/`. The ESLint fence enforces it.

### Test requirements

- Per-view render tests against draft/active/closed fixtures.
- Home-view test update: Enter on phase 1 when Refine is done pushes `{id:'refine-phase'}` via the `routerStub.push` mock.
- Router integration test: given an initial stack with a phase-view id, it renders the right component.
- `phase-run-trace.test.tsx`: one row per `StepExecutionRecord` with ok/error glyph.
- No pipeline/business-layer tests needed — this commit touches integration/ui only.

### Gotchas / risks

- **Do NOT modify use cases or pipelines.** Non-negotiable.
- **Do NOT introduce a `phases/index.ts` barrel.**
- **Do NOT create `'execute-phase'` as a new ViewId.**
- `ExecuteView` mounts `executePipeline` in an effect. Gate drill-in on `snapshot.phases[2].status !== 'pending'` so phase 3 doesn't route to `ExecuteView` for draft sprints with no tasks.
- The stopgap in `PipelineMap` (Enter-on-non-actionable = no-op) must be **replaced**, not supplemented.
- PR creation: verify whether `ExternalPort.createPullRequest(...)` exists before wiring the button. If absent, leave a TODO and omit the button.

---

## Commit C — Live streaming into phase views

### Scope

While a refine or plan pipeline is running, its phase view renders:

- A spinner on the current step.
- A lower pane (`<SessionStreamPane />`) showing the last N events from the session-stream bus.
- Per-chunk AI output lines flow into the pane as the AI produces them.

ExecutePhaseView (routed to `ExecuteView`) already works — this commit only
confirms it still does after B's routing changes.

### Research finding (from the handoff): does publish infrastructure exist?

**No.** `src/business/usecases/{refine,plan}.ts` publish lifecycle logger
events (spinner start/succeed/fail) through `LoggerPort`, but they do NOT
stream AI session stdout. `spawnHeadlessRaw` in `src/integration/ai/session.ts`
holds stdout in a local string and only returns it at close. Streaming is
therefore **new infrastructure**. Call this out in the commit message.

### Files to create

- `src/integration/ai/session-stream.ts` — singleton pub-sub bridge: `getSessionStreamBus()` with `subscribe(listener)` / `publish(chunk, meta)`. Integration-layer only; business never imports. Mirrors `logEventBus`.
- `src/integration/ai/session-stream.test.ts` — pub-sub + buffer-capacity tests.
- `src/integration/ui/tui/runtime/use-session-stream.ts` — React hook `useSessionStream(limit)` mirroring `useLoggerEvents` shape.
- `src/integration/ui/tui/components/session-stream-pane.tsx` — presentational component rendering the tail.
- `src/integration/ui/tui/components/session-stream-pane.test.tsx` — render test.

### Files to modify

- `src/integration/ai/session.ts` — inside `spawnHeadlessRaw`'s `child.stdout.on('data', …)` handler, additionally call `getSessionStreamBus().publish(chunk, { cwd })`. Respect `MAX_STDOUT_SIZE` — do NOT publish once the cap is reached.
- `src/integration/ui/tui/views/phases/refine-phase-view.tsx` — add `useSessionStream()` + `useLoggerEvents()` subscriptions. While `running === true` (local state toggled by the action handler), render `<SessionStreamPane />` below the run trace.
- `src/integration/ui/tui/views/phases/plan-phase-view.tsx` — same pattern.
- `src/integration/ui/tui/views/phases/close-phase-view.tsx` — NOT touched (close doesn't spawn an AI session).

### Architectural notes

- New module is integration-layer. UI hook is same-layer. No violation.
- Bus is a singleton like `logEventBus`. 16ms micro-batching pattern to avoid re-render storms.
- Bus payload: `{chunk: string, cwd: string, timestamp: Date}`. Do NOT shoehorn into `LogEvent` (which has a closed discriminated union).
- `running` is view-local `useState` — do not plumb through SharedDeps.
- No changes to `SignalBusPort` or `logEventBus`.

### Test requirements

- `session-stream.test.ts` — subscribe, publish multiple chunks, assert micro-batched delivery.
- `session-stream-pane.test.tsx` — renders the last N lines.
- Update `refine-phase-view.test.tsx` and `plan-phase-view.test.tsx`: with `running === true` and a mocked bus emitting events, the log pane renders them.

### Gotchas / risks

- **This is new infrastructure.** The handoff's "don't add new streaming infrastructure if it already exists" is moot here — it doesn't exist. Mention in commit message.
- **Non-TTY safety**: `session-stream.ts` must no-op when no subscribers. CLI one-shot invocations must not buffer forever.
- **MAX_STDOUT_SIZE**: respect the cap.
- **No signal-bus abuse**: AI chunks are NOT harness signals. Do not route through `SignalBusPort`.
- **Do not touch the AiSessionPort interface** — wiring happens below the port.
- **Test isolation**: bus is a singleton; `beforeEach` must `dispose()` / reset it.

---

## Commit D — Legacy dead-code purge

### Scope

Delete ~2500 LOC of closed-loop legacy. No behaviour change, no UI change.
`pnpm dlx knip` output after this commit should be strictly smaller.

### Files to delete

- `src/integration/ai/executor.ts` (1353 LOC)
- `src/integration/ai/executor.test.ts` (110 LOC)
- `src/integration/ai/runner.ts` (476 LOC)
- `src/integration/ai/runner.test.ts` (639 LOC)

### Files to modify

Stale comment references to rephrase (do NOT delete these files, just edit comments):

- `src/integration/signals/file-system-handler.ts` line 31 — "Match executor.ts constant" → rephrase.
- `src/integration/ui/theme/ui.ts` line 195 — mentions "ai/executor" → rephrase.

Keep these references (they describe behaviour that still exists, just in
the pipeline layer):

- `src/application/factories.ts` lines 227 / 256 ("executor's scheduler").
- `src/business/pipelines/steps/run-check-scripts.ts` line 39.
- `src/domain/errors.ts` line 227.

### Verification

- `grep -r "from ['\"].*integration/ai/\(executor\|runner\)['\"]" src/ dist/ 2>/dev/null | wc -l` must be 0.
- `pnpm dlx knip` output smaller or equal.
- `pnpm test` green.

### Gotchas / risks

- **Do not also delete `src/integration/ai/evaluator.ts`** — still contains `buildEvaluatorContext`, `getEvaluatorModel`, `parseDimensionScores`, `parseEvaluationResult` used by `output-parser-adapter.ts` and `business/usecases/evaluate.ts`.
- Double-check `src/application/entrypoint.ts` doesn't import from either file.
- Do not regenerate lockfile or touch `package.json`.

---

## Commit E — Session-id resume wiring

### Scope

`git stash pop stash@{0}` restores the session-id resume feature:

- Rate-limited tasks, after the coordinator lifts the pause, relaunch with `--resume <id>` / `--resume=<id>` so the AI continues the same conversation instead of starting fresh.
- Log lines "Resuming previous session: <8-char-prefix>..." confirm the feature fires.

### Files touched by the stash (for verification after pop)

- `src/domain/context.ts` — `resumeSessionId?: string` added to `ExecutionOptions`.
- `src/business/ports/ai-session.ts` — `resumeSessionId?: string` added to `SessionOptions`.
- `src/business/usecases/execute.ts` — forward `options?.resumeSessionId`.
- `src/business/pipelines/execute.ts` — `taskSessionIds` map threaded to per-task pipeline deps.
- `src/business/pipelines/execute/per-task-pipeline.ts` — optional `taskSessionIds` forwarded.
- `src/business/pipelines/execute/steps/execute-task.ts` — reads from map, logs "Resuming previous session: ...", merges into options.
- `src/business/pipelines/execute/steps/execute-task.test.ts` — two new tests (forward / omit).
- `src/business/pipelines/execute/executor-integration.test.ts` — assertion that second spawn call sees `resumeSessionId`.
- `src/integration/ai/session-adapter.ts` — forwards `options.resumeSessionId` in `spawnHeadless` / `spawnWithRetry`.

### Architectural notes

- No new ports. `SessionOptions.resumeSessionId` is purely additive.
- `taskSessionIds` is scheduler-owned (lives in `executeTasksStep`), cleared on successful settle, populated on rate-limit capture.
- One logical change — do not split across commits.

### Procedure

```bash
git stash show stash@{0} --stat   # verify it's the right stash
git stash pop stash@{0}
pnpm typecheck && pnpm lint && pnpm test
git add -A
git commit -m "feat(execute): wire session-id resume into relaunch after rate-limit pause"
```

### Gotchas / risks

- **Verify the stash** via `--stat` before popping — do not blind-pop.
- **Order sensitivity**: land after D so the stash applies cleanly against the cleaned tree. Confirmed: stash only touches `business/*` + `session-adapter.ts`; no conflicts with B/C/D.
- **If pop conflicts**: do NOT `git stash drop`. Resolve manually, keep the stash for recovery.
- **Do not `--amend`** if a hook fails — create a new commit per protocol.

---

## Commit F — RateLimitCoordinatorPort layering fix

### Scope

`src/business/pipelines/execute.ts` no longer imports the concrete
`RateLimitCoordinator` class from `src/integration/ai/rate-limiter.ts`.
Instead, `SharedDeps` carries a factory the pipeline calls. Restores the
Clean-Architecture direction (business depends only on ports).

### Files to modify

- `src/application/shared.ts` — add to `SharedDeps`:
  - `createRateLimitCoordinator: () => RateLimitCoordinatorPort;`
  - Import `RateLimitCoordinator` here (application layer — allowed).
  - Default factory: `() => new RateLimitCoordinator() as RateLimitCoordinatorPort`.
  - Override hook: accept `overrides.createRateLimitCoordinator`.
- `src/business/pipelines/execute.ts` —
  - Delete `import { RateLimitCoordinator } from '@src/integration/ai/rate-limiter.ts';`.
  - Extend `ExecuteDeps` with `createRateLimitCoordinator: () => RateLimitCoordinatorPort;`.
  - Inside `executeTasksStep`, replace `new RateLimitCoordinator() as RateLimitCoordinatorPort` with `deps.createRateLimitCoordinator()`.
- `src/application/factories.ts` — in `createExecuteSprintPipeline`, forward `shared.createRateLimitCoordinator`.
- `src/business/pipelines/execute.test.ts` — update test `ExecuteDeps` stub.
- `src/business/pipelines/execute/executor-integration.test.ts` — same.

### Architectural notes

- Port `RateLimitCoordinatorPort` already exists at `src/business/ports/rate-limit-coordinator.ts`. Do not create a duplicate.
- After commit, `grep -r "from ['\"]@src/integration/ai/rate-limiter['\"]" src/business` must return 0 hits.
- Factory-in-SharedDeps pattern is isomorphic to `persistence` / `filesystem` / `signalBus`. No new pattern.

### Test requirements

- Grep-enforced layering check (above).
- Existing pipeline step-order tests continue to pass.
- Optional: one test in `shared.test.ts` (if it exists) confirming the override path works.

### Gotchas / risks

- **Do not add a backward-compat shim** (e.g. re-exporting `RateLimitCoordinator` from a port file). The whole point is to sever the edge.
- **Do not rename the port** — surface frozen.
- Confirm no other business-layer files import from `rate-limiter.ts` before starting.
- If `eslint.config.js` already has an architectural fence, re-enable or extend after the code is clean.

---

## Commit G — Plateau detection in the evaluator loop

### Scope

When the evaluator produces the **same set of failed dimensions** two
iterations in a row, the loop short-circuits with
`evaluationStatus: 'plateau'` instead of burning through the remaining fix
attempts. Surfaces in `tasks.json`, the JSON schema, and the sidecar
header. No evaluator-prompt changes.

### Files to create

- `src/business/usecases/plateau.ts` — pure comparator `dimensionsEqual(prev, curr): boolean`. Returns true iff the set of **failed** dimension names is identical across two `EvaluationParseResult`s (ignores passed ones — plateau is about stuck failures).
- `src/business/usecases/plateau.test.ts` — unit tests (empty / identical / disjoint / order-insensitive / whitespace-trim).

### Files to modify

- `src/domain/models.ts` — extend `EvaluationStatusSchema` to `z.enum(['passed', 'failed', 'malformed', 'plateau'])`. TS type updates automatically.
- `schemas/tasks.schema.json` — add `"plateau"` to `evaluationStatus.enum`. Update description.
- **Parser output stays narrow** (`'passed' | 'failed' | 'malformed'`). Plateau is loop-derived, not parsed. Do not widen `EvaluationParseResult.status`.
- `src/business/usecases/evaluate.ts`:
  - Track `previousEvalResult: EvaluationParseResult | null` across iterations.
  - After each re-evaluation, if `!isPassed(evalResult) && previousEvalResult !== null && dimensionsEqual(previousEvalResult, evalResult)`, break with internal `LoopStatus = 'plateau'`.
  - `persistEvaluation(...)` still writes the critique body (genuine evaluator output).
  - `updateTaskEvaluation(...)` persists `evaluationStatus: 'plateau'` in `tasks.json`.
  - `reportResult(...)` gains a plateau branch: "Evaluation plateaued on the same failures — marking done: <task>".
  - `EvaluationSummary.status` widens to include `'plateau'`.
- `src/business/pipelines/evaluate.ts` — no behavioural change; widened summary flows through existing step code. Re-read to confirm.
- `src/business/pipelines/evaluate.test.ts` — add a plateau scenario.
- `src/integration/persistence/evaluation.ts` (wherever sidecar writer lives) — verify the status string passes through unchanged. Widen if strictly typed.

### Architectural notes

- Pure comparator placement matches existing `isPassed` helper pattern in `business/usecases/`.
- Parser-output type stays narrow. Plateau is loop-derived, not parsed — mixing would invite bugs where callers try to parse `'plateau'` from AI stdout.
- No changes to `task-evaluation.md` prompt.
- `evaluationIterations` semantics unchanged.

### Test requirements

- `plateau.test.ts` — pure unit tests on the comparator.
- `evaluate.test.ts` (use-case): mock parser returns identical failed dimensions across two iterations → loop stops at iteration 2, summary status is `'plateau'`, `updateTaskEvaluation` called with plateau.
- `evaluate.test.ts` (pipeline): existing step-order tests continue to pass; add a plateau scenario asserting `ctx.evaluationSummary.status === 'plateau'`.
- `json-schema-sync.test.ts` — already enforces enum sync.
- `persistence/evaluation.test.ts` — add a plateau sidecar write case.

### Gotchas / risks

- **Do NOT modify the evaluator prompt.**
- **Do NOT widen `EvaluationParseResult.status`** — keep narrow.
- **Compare the set of failed dimensions**, not `rawOutput` strings — the evaluator rewording the same critique should still be detected.
- **Case/whitespace normalisation** — trim before comparison; cover in tests.
- **Schema sync** — `models.ts` and `schemas/tasks.schema.json` in the same commit or `json-schema-sync.test.ts` fails.
- **Plateau after malformed**: if iteration N is malformed, the loop already bails. Keep that bail in place; plateau detection applies only to consecutive real `'failed'` results.
- **`iterations` counter**: reflect actual evaluator spawns (e.g. 2 for a round-2 plateau). Do not reset.

---

## Commit H — Sprint contract step

### Scope

Before each task's `execute-task` step, the harness writes a markdown
**sprint contract** file at `<sprintDir>/contracts/<taskId>.md` that merges
task name + description + steps + verification criteria + resolved
checkScript + evaluator dimension list. The generator's prompt
(`task-execution.md`) and evaluator's prompt (`task-evaluation.md`) both
reference the contract path so both sides work from the same source of
truth.

### Files to create

- `src/business/pipelines/execute/steps/contract-negotiate.ts` — new step `contract-negotiate`:
  ```ts
  export function contractNegotiate(deps: {
    fs: FilesystemPort;
    persistence: PersistencePort;
  }): PipelineStep<PerTaskContext>;
  ```
  Reads `ctx.task` + `ctx.sprint`, resolves the project's `checkScript` (via the same helper `execute-task` already uses), builds the contract markdown, writes to `<sprintDir>/contracts/<taskId>.md` via `fs.writeFile`, stashes the path on `ctx.contractPath`.
- `src/business/pipelines/execute/steps/contract-negotiate.test.ts` — unit tests (happy path, no-checkScript, no-verificationCriteria, no-steps, fs error).
- `src/business/pipelines/execute/contract-content.ts` — pure builder `buildContractMarkdown(task, project, sprint, evaluatorDimensions)`. Separated so markdown shape can be tested without filesystem mocking.
- `src/business/pipelines/execute/contract-content.test.ts` — pure unit tests.

### Files to modify

- `src/business/pipelines/execute/per-task-context.ts` — add `contractPath?: string` to `PerTaskContext`.
- `src/business/pipelines/execute/per-task-pipeline.ts` — insert `contractNegotiate({fs, persistence})` as the **first** step after `branchPreflight` and before `markInProgress`. New step order:
  ```
  branch-preflight → contract-negotiate → mark-in-progress → execute-task →
    store-verification → post-task-check → evaluate-task → mark-done
  ```
- `src/business/pipelines/execute/per-task-pipeline.test.ts` — update happy-path step-order assertion (insert `'contract-negotiate'` between `'branch-preflight'` and `'mark-in-progress'`). Update all other step-order assertions where the pipeline progresses past branch-preflight. Add a new test for the contract file being written.
- `src/business/pipelines/execute/executor-integration.test.ts` — grep for `'mark-in-progress'` string literals and update. Add at least one integration-level test confirming the contract file is present under `<sprintDir>/contracts/` after a successful run.
- `src/integration/ai/prompts/task-execution.md` — **additive only** reference to `{{CONTRACT_FILE}}`. Suggested placement: early, near the `{{CONTEXT_FILE}}` mention. Use a prose paragraph, not inside a numbered list (numbered lists with empty placeholders create gaps — per handoff prompt-engineering notes).
- `src/integration/ai/prompts/task-evaluation.md` — additive reference to `{{CONTRACT_FILE}}`.
- `src/integration/ai/prompt-builder-adapter.ts` — extend the builder to substitute `{{CONTRACT_FILE}}`.
- `src/business/ports/prompt-builder.ts` — if the signature needs `contractPath` threaded, extend. If the builder reads from `TaskContext`, leave alone. Verify first.
- `src/business/pipelines/execute/steps/execute-task.ts` — pass `ctx.contractPath` into the generator prompt path.
- `src/business/usecases/evaluate.ts` — thread `contractPath` through `EvaluationOptions`. The pipeline populates it from `ctx.contractPath`. **Do NOT re-derive** the path inside the evaluator — it must use the same file the generator saw.

### Architectural notes

- **Evaluator dimensions** are hardcoded in `task-evaluation.md`. Extract the list into a constant (e.g. `EVALUATOR_DIMENSIONS` in `contract-content.ts`) so the contract builder and any future dimension-emission code share it. Verify the exact dimension names from the prompt before writing the constant.
- **Additive-only prompt changes** — placeholders default to empty string via `loader.ts`. Existing numbered lists (Phase 1/2/3) stay intact; insert references in prose.
- **New step placement**: after `branch-preflight` (don't write the contract if the branch is wrong and the task will be requeued), before `mark-in-progress` (contract should exist at the moment the task starts).
- **`ctx.contractPath`**: optional type-wise, but `contract-negotiate` failing fails the pipeline (deterministic I/O). Downstream readers can assume it's set when they run.
- No new SharedDeps entries. `fs` and `persistence` are already in `PerTaskDeps`.

### Test requirements

- **Per-task pipeline step-order tests**: update every `stepResults.map(r => r.stepName)` assertion that reaches past `branch-preflight` to include `'contract-negotiate'`.
- **Executor-integration step-order tests**: grep for `'mark-in-progress'` string literals and update.
- **Contract-negotiate step unit tests**: file written correctly, `ctx.contractPath` populated, error path returns `Result.error`.
- **Contract-content pure builder tests**: exercise edge cases without filesystem.
- **Prompt loader tests**: `{{CONTRACT_FILE}}` placeholder substitutes correctly; empty-string fallback is safe.
- **Sidecar integration check**: contract file exists on disk after the happy path (`executor-integration.test.ts` tmpdir setup).

### Gotchas / risks

- **Architectural-fence tests are non-optional** — do not work around step-order assertions with `toContain` instead of `toEqual`.
- **Both prompts must reference the contract path** — generator and evaluator. Evaluator-only breaks the harness-design symmetry.
- **Do NOT change task-evaluation's scoring rules** — additive context only.
- **Do NOT renumber existing prompt sections** — insert in prose.
- **`<sprintDir>/contracts/` directory** must exist before first write. Either call `fs.ensureDir(...)` in the step or rely on `fs.writeFile` to create parents (verify which `NodeFilesystemAdapter` does).
- **Don't confuse directories**: evaluator sidecar is `<sprintDir>/evaluations/<taskId>.md`; contract is `<sprintDir>/contracts/<taskId>.md`.
- **Do NOT attempt planner dimension emission** — explicitly deferred.
- **Do NOT rename `forEachTask` → `forEachItem`** — explicitly deferred.

---

## Cross-cutting concerns

### Shared test fixtures

- `src/integration/ui/tui/views/home-view.test.tsx` has a draft/active/closed sprint fixture pattern. B's phase-view tests may benefit from a single `src/integration/ui/tui/views/phases/fixtures.ts` (plain module, **not a barrel**) with `makeDraftSprint`, `makePlanningSprint`, `makeExecutingSprint`, `makeClosingSprint` helpers.
- G's plateau test: reuse the evaluator mock pattern in existing `evaluate.test.ts` (line 216+).
- H's contract file assertion: reuse `executor-integration.test.ts`'s `buildDeps` + tmpdir sprint setup.

### Conventions to preserve

- **No barrel files** — holds across all commits. `phases/fixtures.ts` is named exports, not re-exports.
- **ESLint fence (business→integration, CLI/TUI→usecases)**: F is the direct fix; everything else respects it.
- **Integration tests lock step order** — any pipeline-touching commit (E, F, H) updates `stepResults.map(r => r.stepName)` assertions in the same commit.
- **JSON-schema mirror**: any Zod enum change (G) updates `schemas/*.json` in the same commit.
- **Additive-only prompt edits** (H) — do not renumber existing lists.
- **Commit cadence**: one logical change per commit. Do not bundle F into H.
- **`pnpm typecheck && pnpm lint && pnpm test` green at every commit** — no exceptions.

### State shared across commits

- `PerTaskContext` gains a field in H (`contractPath`).
- `SharedDeps` gains a field in F (`createRateLimitCoordinator`).
- `ViewId` gains three entries in B.
- `EvaluationStatus` gains a variant in G.
- `ExecutionOptions` and `SessionOptions` gain `resumeSessionId` in E.

### Files touched by multiple commits

- `src/business/pipelines/execute.ts` — E (stash), F (port refactor). Land E→F so F rebases cleanly.
- `src/business/pipelines/execute/per-task-pipeline.ts` — E (optional `taskSessionIds`) and H (new step). Land E first; H's diff stays a single-line insertion.
- `src/business/pipelines/execute/per-task-pipeline.test.ts` — step-order assertions updated by H. E leaves step-order unchanged.
- `src/integration/ui/tui/views/home-view.tsx` — B (router dispatch). C works inside phase views.

### Critical files for implementation

- `src/business/pipelines/execute.ts`
- `src/business/pipelines/execute/per-task-pipeline.ts`
- `src/business/usecases/evaluate.ts`
- `src/integration/ui/tui/views/view-router.tsx`
- `src/application/shared.ts`
