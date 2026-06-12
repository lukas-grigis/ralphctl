# Tester Memory

## Test Setup

- **Framework:** vitest
- **Config:** `vitest.config.ts` in project root
- **Location:** tests live under `tests/{unit,integration,e2e}/`; flow e2e tests at `tests/e2e/flows/<flow>.test.ts`
- **Commands:** `pnpm test`, `pnpm test:watch`, `pnpm coverage`

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

### Gen-eval exit mapping (2026-06-10)

`finalize-gen-eval` `mapExit` semantics — important for writing correct assertions:

- `passed` → `{ verdict: 'passed' }` — NO warning, NO blockedReason.
- `self-blocked` → `{ verdict: 'failed', blockedReason }` — NO warning.
- `malformed` → `{ verdict: 'malformed', warning: { kind: 'malformed', detail } }`.
- `plateau` → `{ verdict: 'failed' }` — NO warning (plateau is an escalation trigger, not done-with-warning).
- `budget-exhausted` → `{ verdict: 'failed', warning: { kind: 'budget-exhausted', turnsUsed, turnBudget } }`.

The `shouldFailAttempt` field is controlled by the escalation policy (not mapExit), so it can appear independently of the warning. A mutant test needs to assert BOTH fields explicitly — a vacuous `if (result.ok && result.value.warning?.kind === 'plateau')` guard always passes and kills nothing.

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

### Parallel implement wave ordering + lock regression (CS-1D, 2026-06-02)

`tests/integration/application/flows/implement/parallel-ordering-and-lock.test.ts` — 7 tests:

- `scheduleIntoWaves` puts an `in_progress` prerequisite in wave 0 and its dependent `todo` in wave 1
- Dependent wave index is strictly greater than its prerequisite for multi-hop chain (a→b→c)
- Parallel element executes all wave-0 branches before any wave-1 branch starts (log-order fence)
- Non-fatal wave-0 failure absorbed; wave-1 still runs after wave-0 settles
- concurrent `saveAll` (epilogue) + `update` (branch settle) on real `FsTaskRepository` never tears tasks.json
- High-concurrency (16 ops) interleaved `saveAll`+`update` always lands a consistent 4-task set
- Sprint-scoped lock is held when the epilogue runs (`epilogueCalledWhileLockHeld === true`)

**Key pattern**: `scheduleIntoWaves` is status-agnostic — it uses `task.order` + `dependsOn` only. In_progress-first ordering from `resolveImplementQueue` is already baked in the queue before `scheduleIntoWaves` sees it; the wave scheduler enforces the dependency fence.

### Parallel implement real-git e2e test (2026-05-30)

`tests/e2e/flows/implement-parallel-realgit.test.ts` — proves parallel path against a REAL git repo.
**Real bug found (since FIXED via `gitDeleteBranch`; assertion now green):** `gitWorktreeRemove --force`
left the `wt-*` branch refs behind — see [[project_parallel_worktree_branch_leak_bug]].
Happy-path assertions that DID pass: runner `completed`, all 3 tasks `done`, sprint `review`,
4 commits on sprint branch (wave order A/B before C), worktree DIRECTORIES cleaned up.
Provider pattern: `session.cwd` is the worktree path in the parallel path — write real files there.

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

### Gen-eval turn step-order fence + crash-attribution (Batch F, 2026-06-12)

`tests/integration/application/flows/implement/leaves/gen-eval-loop.test.ts` — 4 tests:

- Loop-entry guard: refuses to enter when ctx.lastExit already set (original test)
- Shape fence: asserts gen-eval-turn children order = [resolve-round-num, stamp-meta-generator, stamp-role-meta-generator, generator-leaf, evaluator-guard] by name
- Evaluator-guard body order: [stamp-meta-evaluator, stamp-role-meta-evaluator, evaluator-leaf]
- Crash-attribution: generator spawn fails (recoverable `InvalidStateError`) → loop returns ok with `lastExit.kind==='self-blocked'` AND `rounds/1/generator/meta.json` + `role-meta.json` exist on disk

**Key gotcha**: `InvalidStateError` (code='invalid-state') is treated as RECOVERABLE by `turn-error-policy.ts` — the generator error becomes `self-blocked` exit, NOT a loop `Result.error`. Use `createAtomicWriteFile()` for real file writes in behavioral tests.

**Sequential composites do NOT emit their own trace entry** — only leaves emit trace entries. Assert leaf names in runner.trace, not composite names like 'implement' or 'review'.

### Meta-run flow failure arcs (Batch F, 2026-06-12)

`tests/e2e/meta-flows/run.test.ts` — added 2 arcs:

- Implement-failure: use `makeDoneSprint()` → `loadAndAssertSprintSubChain` fails → review never starts → `feedback.md` never created, runner `status==='failed'`, trace ends with `{ elementName: 'run', status: 'failed' }`
- Review-failure: use `passingProvider` for implement + `failingReviewProvider` (RateLimitError) + `reviewFailingInteractive` (`askTextArea` returns non-empty body) → implement succeeds, sprint reaches 'review', review-round fails → runner `status==='failed'`, `feedback.md` exists (ensureFeedbackFile ran), trace contains 'load-sprint' (implement) + 'review-round' (review failure)

**`RateLimitError` is NOT Aborted** — runner.status becomes 'failed', not 'aborted'. AbortError → 'aborted'.

**Review termination**: `terminatingInteractive.askTextArea` returning `''` leads to `isTerminationRound=true` → review SUCCEEDS (exit='terminated'). For review to fail, provide non-empty body AND use a provider that returns RateLimitError.

### Progress-overlay flake elimination (Batch F, 2026-06-12)

Pattern: add a SEEDED sentinel text to `SeedSelection` that renders only when `seeded=true` (sprint or focusedRun effect has committed). Replace `await tick(50)` with `await waitFor(() => lastFrame().includes('SEEDED'))`.

The sentinel stays visible even after the overlay opens (SeedSelection is rendered outside GlobalHarness's conditional), so asserting overlay content and `not.toContain('UNDERLYING_VIEW')` still works.

For scroll clamp assertions: replace final fixed tick after PgDn/PgUp loops with `waitFor(() => lastFrame().includes('TAIL-LINE'))` or `waitFor(() => lastFrame().includes('HEAD-LINE'))`.

Proved: 10/10 isolated runs pass, 689/689 tui suite passes.
