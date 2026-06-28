# Chain Framework Reference

Companion to [ARCHITECTURE.md](./ARCHITECTURE.md). This document is the canonical reference for the chain
framework that lives under `src/application/chain/`.

> Visual: [diagrams/00-chain-framework.md](./diagrams/00-chain-framework.md)

> The filename is preserved from the v1 docs ("KERNEL-DESIGN.md") so existing cross-references don't break.
> The chain primitives live inside `application/` (there is no `kernel/` module) because they are application
> orchestration, not business logic. The contract below describes what they do today.

## Goal

The chain framework is the application orchestration layer. It sequences and composes business use cases.
It is **not** business logic. It is closer to a workflow engine (Camunda BPMN, Temporal) than to a typical
"pipeline" abstraction — chains are declarative, composable, and inspectable.

Design constraints:

- **Small surface area.** Five concepts total: `Element` (the interface) plus four factories (`leaf`,
  `sequential`, `loop`, `guard`). Conditionals + retry + onError are deliberately omitted — retry on rate
  limits is an adapter concern, and branching belongs inside a use case or a sub-chain selected by the caller.
- **Pure TypeScript, zero deps.** Lives under `src/application/chain/`. Composition root, flows, and tests
  import directly from there.
- **Result-typed.** Every element returns `Result<{ ctx, trace }, { error, trace }>` (typed as
  `ElementResult<TCtx>`). No throws at the framework boundary.
- **Inspectable.** Every element has a `name` and an optional `children` array. Composites expose their
  child elements so the TUI can render the _full_ expected plan upfront (pending glyphs for unstarted steps)
  not only the trace of what has already run.
- **Cancelable.** Every `execute` accepts an `AbortSignal`. A tripped signal materialises as an `aborted`
  trace entry carrying an `AbortError`.
- **Progressive emission.** Every `execute` accepts an `onTrace` callback. Leaves call it once per
  invocation; composites forward it to their children so live UIs render the trace as it grows.

## Element — the interface

```ts
interface Element<TCtx> {
  readonly name: string;
  readonly label?: string;
  readonly children?: ReadonlyArray<Element<TCtx>>;
  execute(ctx: TCtx, signal?: AbortSignal, onTrace?: OnTrace): Promise<ElementResult<TCtx>>;
}

type ElementResult<TCtx> = Result<{ ctx: TCtx; trace: Trace }, { error: DomainError; trace: Trace }>;
```

That is the entire interface. `leaf`, `sequential`, `loop`, and `guard` all return values that satisfy it.
A chain is an Element. A sub-chain is just an Element passed where another Element would be — composition
is implicit.

`name` is the canonical identifier — used for dedupe, trace correlation, and plan/trace merge. **`label`**
is an optional human-friendly display string; UI surfaces (e.g. the Execute-view rail) render `label` when
present and fall back to `name`. Flow authors use `label` to avoid leaking structural data (e.g. absolute
repo paths) into the rendered rail without losing the stable name underneath.

`children` exposes composite structure so callers can walk the tree without executing it. Leaves omit
`children`; composites set it to their immediate children; `loop` returns `[body]` (one element — operators
never see the iteration count in the plan, just the body shape).

`flattenLeaves(element)` (also in `element.ts`) DFS-walks the tree and returns the leaves in order. The TUI
execute view uses it to derive the planned-step list at chain-construction time.

## leaf — the business seam

`leaf` is the only element that knows about use cases. It adapts a `UseCase<UInput, UOutput>` into an
`Element<TCtx>`:

```ts
leaf<TCtx, UInput, UOutput>(name, {
  useCase,
  input: (ctx) => ({ sprintId: ctx.sprintId }),
  output: (ctx, sprint) => ({ ...ctx, sprint }),
});
```

An optional third argument `opts?: { label?: string }` attaches a display label to the resulting element and
every `TraceEntry` it emits. `name` stays the canonical identifier; `label` is purely a UI hint. Omitting
opts or omitting `label` within opts leaves the field absent — callers fall back to `name`:

```ts
leaf('preflight-task-1-/abs/path/my-repo', config, { label: 'preflight · my-repo' });
// rail shows "preflight · my-repo"; trace correlation still uses the full name
```

`input` projects ctx → use-case input. `output` merges use-case output → new ctx. Both projections may throw
a `DomainError` (e.g. a precondition like `ctx.sprint` being undefined when an upstream step should have set
it) — those throws become `failed` trace entries. Any other throw is a programmer bug and re-propagates.

`leaf` is the only place a chain definition mentions a use case. Everywhere else, chains compose other
elements.

## sequential — composite by default

```ts
sequential('refine', [
  loadAndAssertSprint(['draft']), // load-sprint + assert-sprint-status sub-chain
  refineTickets, // ← itself a sequential; composite is just "an Element"
]);
```

Semantics:

- Runs elements in order; threads `ctx` through each.
- On the first `Result.isErr`, aborts the remaining elements (each emits a `skipped` trace entry) and
  returns the error wrapped with the trace up to the failure plus the skipped tail.
- Aborts immediately on `signal.aborted` — the failing-to-start element gets an `aborted` entry; remaining
  elements get `skipped`.
- Emits one trace entry per child element. Composites never report a self-entry.

The implement chain uses a `sequential` of bridge leaves to iterate per-task subchains in topological order
(serial path, `maxParallelTasks === 1`). Concurrent fan-out within a dependency level shipped in 0.9.0 via the
**above-the-chain** orchestrator `runWaves` (`src/application/chain/run/wave-scheduler.ts`), which sequences
whole sub-chains above the primitives — deliberately not a sixth primitive. The five-primitive set
(`element` / `leaf` / `sequential` / `loop` / `guard`) is unchanged; `runWaves` never implements `Element`
and must never be composed into a `sequential` / `loop` / `guard`.

## loop — generator-evaluator primitive

```ts
loop('per-task gen-eval', body, {
  shouldContinue: (ctx, iteration) => ctx.attempt.status === 'in_progress',
  shouldStop: (ctx, iteration) => ctx.attempt.evaluation?.passed === true,
  maxIterations: ctx.maxAttempts ?? settings.harness.maxAttempts,
});
```

Semantics:

- Runs `body` repeatedly, threading ctx through each iteration.
- `shouldContinue(ctx, iteration)` is the **pre-iteration** check. Returning `false` exits with the current
  ctx (no body run that round).
- `shouldStop(ctx, iteration)` is the **post-iteration** check. Returning `true` exits with the body's ctx
  (last round counted, exit clean).
- `maxIterations` (default `1000`) is the hard cap. **Hitting the cap is an ok-return**, not a failure —
  callers distinguish budget exhaustion from natural termination via ctx state.
- Aborts on `signal.aborted` mid-iteration with a final `aborted` entry.
- Body failure (`Result.isErr`) ends the loop with the failure wrapped.

`loop` is used twice in the implement flow. The inner `loop('gen-eval-<id>')` body is a `sequential` of
`generator-leaf → guarded evaluator-step`; the evaluator step is itself a `sequential` of
`evaluatorLeaf → loopDiversityCheckLeaf → entropyCheckLeaf`. The two check leaves each emit a `plateau`
exit on ctx when they detect stagnation — `loop-diversity-check` when the failed-dimension fingerprint
repeats for `DIVERSITY_WINDOW_SIZE` (3) consecutive turns, `entropy-check` when the normalised Shannon
entropy over the generator's per-turn signal-kind distribution collapses below a threshold (secondary,
softer signal). The loop exits when any leaf sets `ctx.lastExit` or the `maxTurns` budget is reached.
An outer `loop('task-attempts-<id>')` re-runs the whole attempt segment (`start-attempt → … →
settle-attempt → progress-journal`) until the task settles `done`/`blocked` or `task.maxAttempts` fires.

## guard — predicate-skipped body

```ts
guard('emit-pr', (ctx) => ctx.sprint.status === 'review', createPrLeaf);
```

Semantics:

- If `predicate(ctx)` returns `false`, the body is skipped and a `skipped` trace entry is emitted for
  `body.name`. Ctx is unchanged.
- If `predicate(ctx)` returns `true`, the body executes normally and its result is forwarded.
- Aborts on `signal.aborted` before the predicate runs.

`guard` is the workhorse for "only run this step when X." Use it instead of duplicating chain branches.

## Why no retry / onError element

- **Retry**: rate-limit retry is an _adapter_ concern. The headless provider wrapper
  (`integration/ai/providers/_engine/`) retries with exponential backoff on `RateLimitError`; per-spawn
  retries are capped by `settings.harness.rateLimitRetries`. Putting retry in the chain framework would
  duplicate this concern at a higher layer.
- **OnError**: two-way branching always reduces to one of:
  - A use case that decides what to do (and its result drives the next step in the chain).
  - A pre-built chain selected by the caller before chain construction.
  - A `guard` over the branch body.
    Embedding `if/else` as a framework primitive complicates the surface, makes traces less readable, and
    encourages logic to leak out of business code.

If a recurring branching pattern emerges where neither option fits cleanly, an `onError` or `branch`
primitive can be added — but only with a documented justification.

## Trace contract

```ts
type TraceStatus = 'completed' | 'failed' | 'skipped' | 'aborted';

interface TraceEntry {
  readonly elementName: string;
  readonly label?: string; // copied from Element.label when present; absent otherwise
  readonly status: TraceStatus;
  readonly durationMs: number;
  readonly error?: DomainError; // populated when status is 'failed' or 'aborted'
}

type Trace = readonly TraceEntry[];
```

This is the architectural fence: every chain definition has an e2e flow test asserting
`trace.map(s => s.elementName)` for happy + failure paths. Step-order regressions break the build.

`label` in a `TraceEntry` is copied verbatim from the source `Element.label` at the moment the entry is
recorded. Synthetic entries (`skipped`, `aborted`) constructed without an originating element omit it.

### Progressive emission

`Element.execute(ctx, signal?, onTrace?)` accepts the optional callback. Each implementation calls it as
elements complete:

- `leaf` once per use-case call.
- `sequential` once per child (forwarded from the child plus self-synthesised `skipped` / `aborted` entries).
- `loop` once per iteration body completion.
- `guard` once for the body (`skipped` if the predicate fails, otherwise forwarded from the body).

The final returned `Trace` is the union of those emissions. Live UIs subscribe via the runner's
`subscribe(...)` and receive `step` events as they happen.

## The runner

`createRunner({ id, element, initialCtx })` (`src/application/chain/run/runner.ts`) wraps one
`element.execute()` call with:

- **Status machine**: `idle → running → completed | failed | aborted`. Idempotent: repeated `start()`
  returns the same promise; `abort()` is idempotent.
- **Event stream**: `subscribe(listener)` receives `RunnerEvent<TCtx>`:
  - Success: `started → step* → completed`
  - Failure: `started → step* → failed`
  - Aborted pre-run: `aborted` only (no `started`)
  - Aborted mid-run: `started → step* → aborted`
- **Late-subscriber replay**: a listener added after a terminal state receives every recorded `step` event
  plus the matching terminal event. UI re-attach is lossless.
- **Trace ring buffer**: `runner.trace` is capped at `MAX_TRACE_ENTRIES = 5_000` (defined and enforced in
  `src/application/chain/run/runner.ts`) to bound the snapshot late subscribers replay from. Live subscribers
  still see every event; the cap only bounds the replay snapshot.
- **Session scope**: the runner enters the `runWithSession(id, …)` scope before calling
  `element.execute(...)`. Deep adapter code can read `currentSessionId()` to tag logs / signals.

## Examples

### refineFlow

```ts
sequential('refine', [
  loadAndAssertSprint(['draft']), // load-sprint + assert-sprint-status
  sequential(
    'refine-tickets',
    tickets.map((t) =>
      sequential(`refine-${t.id}`, [
        fetchIssueContextLeaf, // pre-fetch the upstream issue body via gh/glab
        buildUnitLeaf(/* refinement/<ticket-slug>/ */),
        renderPromptToFileLeaf,
        installSkillsLeaf({ name: `install-skills-${t.id}` }),
        stampSessionMetaLeaf,
        refineTicketInteractiveLeaf, // reads <unit-root>/signals.json (refine contract), updates ticket
        uninstallSkillsLeaf({ name: `uninstall-skills-${t.id}` }),
        saveSprintLeaf,
      ])
    )
  ),
]);
```

### implementFlow (per-task gen-eval loop)

> Simplified for readability. The live topology in
> `src/application/flows/implement/leaves/per-task-subchain.ts` additionally wraps the task body in a
> dependency-gate `guard` and adds restore / quarantine diff leaves. This sketch shows the loop / guard
> skeleton, not every leaf.

```ts
const perTask = sequential('task-<id>', [
  // Once-per-task prologue (skills install is not per-attempt).
  branchPreflightLeaf,
  buildTaskWorkspaceLeaf,
  installSkillsLeaf, // copies bundled skills into <repo>; git-excludes via ralphctl-*
  // Outer attempt loop — re-runs the whole attempt segment up to `task.maxAttempts`
  // times until the task settles `done`/`blocked`. `maxAttempts === 1` runs it once.
  loop(
    'task-attempts-<id>',
    sequential('task-attempt-body-<id>', [
      startAttemptLeaf,
      preTaskVerifyLeaf, // baseline before AI runs; result stored for attribution
      loop(
        'gen-eval-<id>',
        sequential('gen-eval-turn-<id>', [
          generatorLeaf, // writes rounds/<N>/generator/prompt.md before spawn
          guard(
            'evaluator-guard-<id>',
            (ctx) => ctx.lastExit === undefined,
            sequential('evaluator-step-<id>', [
              evaluatorLeaf, // writes rounds/<N>/evaluator/prompt.md before spawn
              loopDiversityCheckLeaf, // exits 'plateau' when failed-dimension fingerprint repeats
              entropyCheckLeaf, // exits 'plateau' when signal-kind entropy collapses (secondary)
            ])
          ),
        ]),
        {
          shouldContinue: (ctx, i) => ctx.lastExit === undefined && i <= settings.harness.maxTurns,
          shouldStop: (ctx) => ctx.lastExit !== undefined,
        }
      ),
      finalizeGenEvalLeaf,
      postTaskVerifyLeaf, // attributes outcome (clean/regressed/baseline-broken/fixed-baseline)
      guard('commit-task-guard-<id>', (ctx) => ctx.lastBlockReason === undefined, commitTaskLeaf),
      settleAttemptLeaf, // writes rounds/<N>/outcome.md (the next leaf appends to the journal)
      appendLearningsLeaf, // appends <learning> signals to the project ledger
      progressJournalLeaf, // appends the attempt section to the append-only progress.md journal
    ]),
    {
      maxIterations: task.maxAttempts,
      shouldStop: (ctx) => terminalTaskStatus(ctx, taskId), // task settled `done`/`blocked`
    }
  ),
  // Once-per-task epilogue.
  uninstallSkillsLeaf, // removes harness-installed ralphctl-* skills from <repo>
]);

// Order is set at planning time via `Task.order` (the planner has full graph context;
// `Task.blockedBy` is validated for cycles + dangling refs by `parseTaskList` but not
// re-consulted at launch). Launch-time sort is status-only — in_progress first, so a
// resumed sprint picks up the prior aborted task before any fresh work.
const orderedTasks = [...tasks].sort((a, b) => (a.status === b.status ? 0 : a.status === 'in_progress' ? -1 : 1));

// The whole run is wrapped in `withRepoLock(...)` (src/application/flows/_shared/with-repo-lock.ts),
// a ctx-generic helper keyed on the sprint dir — shared by both implement (serial path) and review,
// so an implement run and a review run of the same sprint mutually exclude. The parallel implement
// path holds the same lock key directly in parallel-element.ts (spanning prologue + waves + epilogue).
sequential('implement', [
  withRepoLock(
    {/* sprint-dir lock */},
    sequential('implement-locked', [
      loadAndAssertSprint(['planned', 'active']), // load-sprint + assert-sprint-status
      activateSprintLeaf,
      loadSprintExecutionLeaf,
      loadTasksLeaf,
      resolveBranchLeaf, // assign + checkout the sprint branch first
      sequential('working-tree-clean-checks', cleanLeaves), // hard-abort if any repo is dirty
      appendJournalSeparatorLeaf, // appends the 'activated' separator to the append-only progress.md journal
      setupScriptRunnerLeaf, // runs after branch + clean checks pass; appends SetupRun entries to SprintExecution.setupRanAt
      sequential('preflight-tasks', preflightLeaves),
      sequential(
        'implement-tasks',
        orderedTasks.map(() => perTask)
      ),
      saveTasksLeaf,
      guard(
        'transition-sprint-to-review-when-any-done',
        (ctx) => ctx.tasks?.some((t) => t.status === 'done'),
        sequential('transition-to-review-and-journal', [
          transitionSprintToReviewLeaf,
          appendJournalSeparatorLeaf, // appends the 'review' separator to the progress.md journal
        ])
      ),
    ])
  ),
]);
```

## Implementation guidelines

- Each primitive is its own file under `src/application/chain/build/` (one of `leaf.ts`, `sequential.ts`,
  `loop.ts`, `guard.ts`). No barrels.
- The `Element` interface and the helpers (`flattenLeaves`, `checkAborted`, `abortedEntry`,
  `skippedEntry`) live in the parent folder (`element.ts`, `trace.ts`).
- Tests live under `tests/unit/application/chain/` (mirroring the source path). A failing test must precisely
  identify which primitive broke.

## What is **not** in the chain framework

- Use cases — those are `business/<module>/`.
- Flow compositions — those are `application/flows/<flow>/`.
- Provider-specific orchestration — rate-limit retry lives in `integration/ai/providers/_engine/`, the idle
  watchdog there too. Cross-process file locks live in `business/io/` + `integration/io/`. The chain framework
  composes use cases that consume these ports; it does not embed any of them.
