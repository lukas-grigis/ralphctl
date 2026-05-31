# Tester Memory

## Test Setup

- **Framework:** vitest
- **Config:** `vitest.config.ts` in project root
- **Location:** Colocated `*.test.ts` files — main tree under `src/`, new tree under `src/`
- **Commands:** `pnpm test`, `pnpm test:watch`, `pnpm test:coverage`

### Coverage configuration (A2 — 2026-05-04)

- `@vitest/coverage-v8` v4.1.5 already installed; `test:coverage` script already existed.
- `vitest.config.ts` now has `coverage.include` (golden-path modules only), `coverage.reportOnFailure: true`
  (so the report prints even when a pre-existing test is red), and `coverage.thresholds`.
- Measured numbers (full suite minus the pre-existing `cli.test.ts` failure):
  statements 86.52% · branches 73.85% · functions 95.92% · lines 90.61%
- Thresholds set: lines 80, branches 68, functions 80, statements 80.
  Branches floor is 68 (5 pp below measured) because branches are the weakest metric.
  All others hit the quality-sprint goal of 80% directly since measured coverage exceeds it.
- Pre-existing failure: `cli.test.ts > sprint create-pr > creates a PR via the chain ...` exits 1 —
  threshold gate passes; the failure is unrelated to coverage.

## Architecture Migration

The active codebase is migrating from `src/` (legacy) to `src/` (Clean Architecture). Both trees have tests.
The deletion commit is `afe771f9`. Legacy tests: `git show afe771f9~1:src/...`.

## src/ Test Coverage Summary

### Integration — AI Providers

- `src/integration/ai/providers/claude-adapter.test.ts` — metadata, buildInteractiveArgs, buildHeadlessArgs (exact
  order), parseJsonOutput, detectRateLimit (all patterns incl. empty stderr, 5xx, retry-after:N), buildResumeArgs (
  valid, invalid: hyphen/space/metachar/empty/too-long), getSpawnEnv
- `src/integration/ai/providers/copilot-adapter.test.ts` — same shape, plus extractSessionId (share-file TOCTOU),
  detectRateLimit (overloaded/529/empty/retry-after:N)

### Integration — AI Session

- `src/integration/ai/session/process-runner.test.ts` — stdout/stderr capture, non-zero exit, ENOENT→StorageError,
  stdin, env merge, abort pre-spawn, SIGTERM→SIGKILL escalation, cwd verification via `pwd`, ESRCH tolerance

### Integration — External

- `src/integration/external/check-script-runner.test.ts` — exit 0/non-zero, combined output, RALPHCTL_LIFECYCLE_EVENT,
  per-call timeout, missing binary, >2 MB output (maxBuffer regression), timeout kills child

### Integration — Persistence

- `src/integration/persistence/file-locker.test.ts` — acquire/release, stale timestamp takeover, dead-PID takeover,
  corrupted lock, throw-release, PID+timestamp content, concurrent DIFFERENT targets (parallel, no deadlock), sequential
  re-acquire idempotency
- `src/integration/persistence/file-task-repository.test.ts` — findBySprintId empty, saveAll round-trip, replace,
  findById, NotFoundError (missing id in real sprint), update in-place, update NotFoundError (no file/unknown id), order
  preserved, concurrent updates serialised, round-trip all optional fields (
  description/verificationCriteria/extraDimensions/verificationOutput/evaluationOutput/evaluationStatus/evaluationFile),
  update leaves siblings unchanged

### Integration — Signals

- `src/integration/signals/file-system-handler.test.ts` — progress+files→progress.md, note→progress.md,
  blocked→progress.md, append-only, evaluation sidecar+progress, sidecar overwrite, evaluation without taskId→error,
  task-verified/task-complete→no-op, check-script/agents-md→no-op, concurrent serialisation

### Integration — Logging

- `src/integration/logging/jsonl-file-writer.test.ts` — write→jsonl, multi-line, concurrent (no interleave), context
  payload, lazy mkdir, reuse existing dir, write-after-dispose→error, dispose idempotent, dispose-without-write creates
  no file

### Chain flow tests — abort + short-circuit pattern (2026-04-29)

Added to all 6 chain flow test files (`evaluate/execute/feedback/ideate/plan/refine`):

- **Step short-circuit**: mid-chain leaf returning error → remaining steps have `status: 'skipped'`, verified via
  `trace.slice(failedIdx + 1)`.
- **Abort propagation**: pre-aborted `AbortController.signal` passed to `flow.execute(ctx, ac.signal)` →
  `result.error.code === 'aborted'` and at least one trace entry with `status: 'aborted'`.

### Business use case coverage (2026-04-29)

- `execute-single-task.test.ts`: empty stdout→failed, multiple blocked signals→all captured,
  task-verified+task-complete, task-complete alone (no task-verified required)
- `evaluate-task.test.ts`: evaluation-failed with empty critique still emits failed signal (when dimensions present)
- `refine-single-ticket.test.ts`: empty AI output → approved with empty requirements (documents: no length guard in use
  case)
- `plan-sprint-tasks.test.ts`: ticketId cross-reference intentionally not validated (documented test)

### SessionManager coverage (2026-04-29)

- `kill()` on completed runner: removes from registry, fires `removed` event, returns ok
- Two concurrent `start()` calls: distinct ids, two `added` events in order
- Late subscribe on terminated session: descriptor stays in registry until `kill()`, subscriber sees future events (no
  historical replay)
- `dispose()` while mid-step: explicitly tests await-and-abort pattern

### CLI coverage (2026-04-29)

- `task add --criterion` repeated: all criteria captured
- `sprint create` 200+ char name: accepted (no max-length guard in entity)
- doctor with corrupt `projects.json`: `writeFile` seeds corrupt file, deps rebuilt from same root → `EXIT_ERROR`
- `config set evaluationIterations` non-integer: `EXIT_ERROR`; value `0` accepted

### Storage paths coverage (2026-04-29)

- `RALPHCTL_ROOT` trailing slash: preserved verbatim via `trustString` (not stripped)
- `RALPHCTL_ROOT` with `~/...`: tilde NOT expanded (document: caller responsibility)

## Known Regression (not fixed here)

`RALPHCTL_SETUP_TIMEOUT_MS` env var: Legacy `runLifecycleHook` read the env var to set default timeout.
`src/CheckScriptRunner` accepts a constructor arg but the composition root (`shared-deps.ts`) calls
`new CheckScriptRunner()` without reading the env var. The env-var override path is missing.
**Fix required in `shared-deps.ts`** — read and pass `RALPHCTL_SETUP_TIMEOUT_MS` when constructing `CheckScriptRunner`.

## Test Patterns (src style)

### Result-typed assertions

```typescript
const r = await repo.findById(sprintId, t.id);
expect(r.ok).toBe(true);
if (r.ok) expect(r.value.name).toBe('findable');

expect(r.ok).toBe(false);
if (!r.ok) expect(r.error.code).toBe('not-found');
```

### Branded value objects

```typescript
const path = AbsolutePath.trustString('/code');
const sprintId = SprintId.trustString('20260429-120000-demo');
const taskId = TaskId.trustString('abcdef01');
const slug = Slug.parse('demo');
if (!slug.ok) throw slug.error;
```

### Temp dirs

```typescript
function uniqueRoot(): AbsolutePath {
  return AbsolutePath.trustString(
    join(
      tmpdir(),
      `ralphctl-<module>-${String(process.pid)}-${String(Date.now())}-${String(Math.random()).slice(2, 8)}`
    )
  );
}
// Clean up in afterEach: await rm(root, { recursive: true, force: true })
```

### Windows skip for shell-dependent tests

```typescript
if (process.platform === 'win32') return;
```

## Mocking Strategies (src)

- **No module-level `vi.mock`** for integration tests — they use real implementations with temp dirs (exception: mocking node builtins like `node:fs/promises` to inject specific error codes deterministically, where real filesystem cannot reproduce the exact error code reliably)
- **`vi.mock('node:fs/promises', ...)` for named-import injection**: ESM named imports bind at link time, so `vi.spyOn` on the namespace object only intercepts namespace-qualified calls (e.g. `fs.readFile()`), not already-bound local `readFile` identifiers. `vi.mock` hoisting replaces the entire module factory before any import is evaluated — the only reliable seam for named-import interception. Put this in a SEPARATE test file so it doesn't affect co-located real-fs tests.
- `AbsolutePath.trustString()` bypasses the VO validator for test paths (use only when you own the value)
- Domain entity creation via static factory: `Task.create({...})` returns `Result<Task, ValidationError>`

### Chain leaf unit tests (2026-05-04)

Four leaves directly unit-tested in `src/application/chains/leaves/`:

- `build-execution-unit.test.ts` — FakeSessionFolderBuilderPort + FakeAiSessionPort; asserts on `executionCalls`,
  `priorEvaluations` map (only non-empty evaluated tasks), all 4 ctx fields stamped, guard failures, custom name.
- `build-planning-folder.test.ts` — same fake pair; asserts on `planningCalls`, claude vs copilot `addDirs`
  difference, cwd === planningFolderRoot, path sub-strings (session.md, tasks.json), guard failure.
- `build-refinement-unit.test.ts` — asserts on `refinementCalls`, title-derived slug appears in unit root path,
  all 4 ctx fields stamped, two guard failures (sprint, currentTicket), custom name.
- `export-sprint-requirements.test.ts` — FakeWriteContextFilePort; sets `RALPHCTL_ROOT` in beforeEach (
  resolveStoragePaths reads env at call time); asserts path contains sprint id + "requirements.json", JSON content (only
  approved tickets), ctx identity (output is identity), custom name, sprintId-from-ctx vs sprint.id distinction.

**Key pattern**: `Sprint.addTicket()` returns `Result<Sprint, ...>` — must unwrap with
`if (!r.ok) throw r.error; sprint = r.value`.

## Gotchas

- **`afterEach` import**: Only import if used — `@typescript-eslint/no-unused-vars` will fail lint
- **`src/` uses `import type` for type-only imports** — enforced by lint
- **No barrel files** — imports always point to source modules directly
- **`// Ported from afe771f9~1:src/...`** comment convention marks tests backported from legacy
- **`Leaf.input()` throws are caught by `runLeaf`**: the framework catches the throw from `input()` and wraps it in
  `Result.error` — the promise resolves, it does NOT reject. Use `result.ok === false` assertions, NOT
  `rejects.toThrow`.
- **`resolveStoragePaths()` inside a leaf execute body**: it reads `process.env.RALPHCTL_ROOT` at call time (not import
  time). Set the env var in `beforeEach`/`afterEach` — no vitest setup file needed for leaves that call it inline.
- **`Sprint.recordCheckRun(repo, at)`** returns a plain `Sprint` (no `Result` wrapper); `setBranch` and
  `setAffectedRepositories` return `Result<Sprint, InvalidStateError>`.

### Launcher HITL distill confirm gate (2026-05-31)

`tests/unit/application/ui/shared/launch/distill-confirm-abort.test.ts` — 10 tests covering `launchCloseSprint` and `launchReview`:

- `abort` (AbortError) on distill confirm → `{ ok: false, reason: 'Cancelled.' }` (load-bearing: fails if guard removed)
- `Result.ok(false)` on distill confirm → runner returned (no cancel; distillRequested: false)
- `Result.ok(true)` on distill confirm → runner returned (distillRequested: true)
- close-sprint: first close confirm aborted → Cancelled
- no sprint selected / no project loaded → early failure from each launcher

**Key patterns:**

- `LaunchContext` stub: partial `AppDeps` cast `as never` for fields the launch path never reaches before the guard
- `identityBridge = <T>(r: Runner<T>) => r` — no event bus needed for launcher unit tests
- `makeSnapshot({ omitSprint: true })` / `makeSnapshot({ omitProject: true })` — `exactOptionalPropertyTypes` forbids `{ sprint: undefined }` in a `Partial<AppStateSnapshot>` spread; use named boolean flags instead
- `scriptedConfirm` builds the prompt fake as an array of response factories (zero-arg functions); `void input` suppresses unused-var lint

### Template registry fence (2026-05-04)

`src/integration/ai/prompts/template-registry.test.ts` — 3 tests catching all three drift modes:

- `every .md file in templates/ is registered in TEMPLATE_NAMES` — `readdirSync` stems vs
  `Object.values(TEMPLATE_NAMES)`
- `every TEMPLATE_NAMES entry resolves to an existing .md file` — set-membership check
- `every TEMPLATE_NAMES key is loaded by at least one source file` — regex `TEMPLATE_NAMES\.<key>(?![A-Za-z0-9_])`
  across all non-test `.ts` files in `prompts/` (word-boundary suffix prevents prefix-collision false-positive accepts)

**Key design decisions:**

- `TEMPLATE_NAMES` lives in `prompt-template-names.ts`; loads are split across `prompt-builder-adapter.ts` +
  `prompt-partials-loader.ts` — scan the entire `prompts/` directory (all non-test `.ts`) to cover all consumers
  automatically.
- Word-boundary regex (`(?![A-Za-z0-9_])`) prevents `plan` matching inside `planInteractive` — pure `String.includes`
  fails here.
- Removed the orphan `plan` key from `TEMPLATE_NAMES` (it was a dead alias for `planCommon`); updated the assertion in
  `prompt-builder-adapter.test.ts` from `TEMPLATE_NAMES.plan` to `TEMPLATE_NAMES.planCommon`.

**Vitest lint rules to observe:**

- `vitest/valid-expect` — `expect()` takes at most 1 argument; no Jest-style `expect(val, 'message')`.
- `vitest/prefer-strict-equal` — use `toStrictEqual()` not `toEqual()` for array/object assertions.

### E2E golden paths (2026-05-04)

`src/_e2e/refine-plan-golden.e2e.test.tsx` — 2 tests covering refine + plan back-to-back:

- **refine-flow**: draft sprint with 2 pending tickets, scripted AI output (raw text fallback path), asserts every
  ticket `requirementStatus === 'approved'` after the chain, pins full step trace including both per-ticket sub-chains
  (each ticket contributes 8 steps inside `refine-tickets`).
- **plan-flow**: post-refine sprint (all tickets approved, built with `makeApprovedTicket()`), single-repo project
  (`makeProject()` → `/tmp/demo-repo`), 3-task linear dep chain in AI output (task-a → task-b → task-c). Asserts
  tasks persisted, `blockedBy` cross-references resolve to real `TaskId`s, `affectedRepositories` set, trace pinned.

**Key design decisions:**

- Does NOT mount the TUI (`bootExecuteScenario` pattern not used) — runs chains directly via `createTestDeps` +
  `flow.execute()`. Cleaner and faster; TUI rendering is tested by the execute golden path.
- `persist-repo-selection` short-circuits the checkbox prompt for single-repo projects — no `FakePromptPort` needed.
- `confirm-replan` and `confirm-task-list` skipped when `interactive` is not set (both check `if (!input.interactive)`).
- Tasks in AI JSON must use `projectPath: "/tmp/demo-repo"` — `validateTasksAgainstSprint` enforces projectPath ∈
  `affectedRepositories`.
- `parseRequirementsJson` falls back to raw text as requirements body — plain string AI output works for refine tests.
- The snapshot-existing-tasks leaf dynamically imports `storage-paths.ts` and reads `RALPHCTL_ROOT` at call time;
  the snapshot is best-effort (silently skipped when the file doesn't exist), so no env-var setup is needed.

### Sprint-selection redesign tests (2026-05-22)

New test files under `tests/integration/application/ui/tui/views/` and `tests/unit/`:

- `sprint-bound-flow-reseat.test.tsx` — reseat wiring contract using fake runner; asserts `setSprint` called on
  `completed+ctx.sprint`, NOT on `aborted`/`failed`/`started`.
- `tests/unit/application/ui/shared/state-snapshot-done-filter.test.ts` — `loadAppStateSnapshot` recentSprints excludes
  `done` sprints.
- `tests/unit/application/ui/tui/runtime/selection-done-on-boot.test.tsx` — `SelectionProvider` clears
  sprintId/sprintLabel when rehydrated sprint has `status: 'done'`. **Requires `sprintRepo` prop on SelectionProvider.**
- `home-create-hotkey.test.tsx` — `+` on Home routes to create-sprint flow; no-op without project.
- `home-switch-feedback.test.tsx` — "✓ now on <name>" feedback after switch; disappears after ~3s with fake timers.
- `pick-sprint-create-row.test.tsx` — PickSprintView renders "Create new sprint" row BEFORE project groups; Enter on it
  launches create-sprint.
- `sprint-detail-no-auto-sync.test.tsx` — SprintDetailView MUST NOT call `setSprint` on mount (inverse of old
  behaviour). Uses `Object.assign(selection, { setSprint: spy })` pattern from `MakeSpy` component.
- `sprint-detail-make-current.test.tsx` — `m` key calls `setSprint(id, name)`; `· current` badge visible when sprint
  matches selection.

**Key pattern: MakeSpy / intercept pattern for selection** — `Object.assign(selection, { setSprint: spy })` inside a
child component `useEffect` lets you intercept context calls without forking the provider.

**JSX in test files**: Always use `.tsx` extension even for unit tests that import/render React components.

**Fake timers + ink-testing-library**: `vi.useFakeTimers()` + `vi.runAllTimersAsync()` causes infinite loops due to
Ink's Spinner `setInterval`. Use `vi.advanceTimersByTimeAsync(N)` instead. For time-gated render conditions (e.g. a
toast freshness check), use `vi.spyOn(Date, 'now').mockReturnValue(BASE_TIME + 3100)` to advance the clock, then force a
re-render via a context state change (e.g. `selection.setSprint(...)` from a helper component) —
`setLocalError((curr) => curr)` bails out of React render (same value → no render committed). The `SwitchTrigger` helper
pattern (component that calls `selection.setSprint` in a once-only `useEffect`) is preferred over keyboard navigation
for deterministic sprint-switch tests. **`frame.indexOf('Alpha Project')` matches ViewShell breadcrumb chrome** — use
line-by-line search filtering lines containing `'project:'` to find the actual group header row.

**`ActionMenu` cursor + UUIDv7 ordering**: `makeDraftSprint` generates time-ordered UUIDs; created later = larger UUID =
appears first in `recentSprints` (DESC sort). `initialMenuIndex` seeds to the current sprint's row. Pressing `k` (up)
from the current sprint's row reaches the newer sprint at index 0.

### E2E execute golden-path artefacts (2026-05-04)

`src/_e2e/execute-golden-artefacts.e2e.test.tsx` — 3 focused `it(...)` cases complementing `golden-path.e2e.test.tsx`:

- **commit-task SHA**: `external: { uncommitted: true }` makes `hasUncommittedChanges()` return true for both the
  dirty-tree preflight AND `commit-task`. Must also queue `promptPort.queueSelect('continue')` on a `FakePromptPort`
  passed as the `prompt` option — otherwise `dirty-tree-preflight` fires a select prompt that throws in the no-queue
  fake. Asserts `task.commitSha` matches `/^fakecommit/` and `ext.commitChangesCalls[0].message` matches `/^task\(/`.
- **`evaluations/<task-id>.md` with `(score N/5)`**: Overrides `signalHandler` with a real
  `FileSystemSignalHandler(resolveStoragePaths())`. Must pre-create the execution unit directory with
  `mkdir(..., { recursive: true })` so the handler can write. Signal includes `DimensionScore` with `score: 5`. Asserts
  file content contains `(score 5/5)`, `Overall score: 5/5`, and `# Evaluation — passed`.
- **`done-criteria.md` round-trip**: Pre-writes via `renderDoneCriteria([task])` +
  `writeFile(paths.doneCriteriaFile(sprint.id), ...)`. Enables `evaluationIterations: 1` so the evaluate-task leaf reads
  it via `readDoneCriteriaBullet`. Asserts runner reaches `completed` and file is unchanged after execute.

**Key pitfall**: `dirty-tree-preflight` runs at the outer execute flow level (before per-task chains) and calls
`hasUncommittedChanges` on every unique task `projectPath`. Setting `external.uncommitted: true` triggers it. Always
queue a `FakePromptPort` select answer when the sprint has tasks with an uncommitted tree.

**Key pitfall**: `FileSystemSignalHandler` uses `resolveStoragePaths()` (reads `RALPHCTL_ROOT` from env) to compute the
evaluation file path — independent of `FakeSessionFolderBuilderPort.evaluationMdPath`. The handler path is
`executionUnitDir(sprintId, unitSlug(taskId, taskName)) + '/evaluation.md'`.

### Prompt completeness smoke tests (2026-05-04)

`src/integration/ai/prompts/prompt-completeness.smoke.test.ts` (extended, 22 tests total):

- All 7 public builder methods tested with real templates from disk via `FileTemplateLoader`.
- Asserts `/\{\{[A-Z_]+\}\}/g` matches nothing after substitution.
- **8 new tests added** covering optional-field branches not previously exercised:
  - `buildRefinePrompt` — pre-fetched `issueContext` text (wraps in `<context>` block)
  - `buildExecutePrompt` — with `checkScript` (fenced shell block rendered); sprint with `branch` set (BRANCH_LINE
    populated); sprint with `setupRanAt` stamped (ENVIRONMENT_STATUS shows timestamp not "Not run.")
  - `buildEvaluatePrompt` — with `evaluateWorkspaceDir` (Contract files section rendered)
  - `buildFeedbackPrompt` — sprint without a branch (BRANCH_SECTION collapses to empty string)
  - `buildPlanPrompt` — sprint with `affectedRepositories` set (repos in CONTEXT block)
  - `buildIdeatePrompt` — sprint with `affectedRepositories` set (non-empty REPOSITORIES block)
