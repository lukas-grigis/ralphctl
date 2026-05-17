# Chain Framework Reference

Companion to [ARCHITECTURE.md](./ARCHITECTURE.md). This document is the canonical reference for the chain
framework that lives under `src/application/chain/`.

> The filename is preserved from the v1 docs ("KERNEL-DESIGN.md") so existing cross-references don't break.
> v0.7.0 has no `kernel/` module — the chain primitives live inside `application/` because they are application
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
  readonly children?: ReadonlyArray<Element<TCtx>>;
  execute(ctx: TCtx, signal?: AbortSignal, onTrace?: OnTrace): Promise<ElementResult<TCtx>>;
}

type ElementResult<TCtx> = Result<{ ctx: TCtx; trace: Trace }, { error: DomainError; trace: Trace }>;
```

That is the entire interface. `leaf`, `sequential`, `loop`, and `guard` all return values that satisfy it.
A chain is an Element. A sub-chain is just an Element passed where another Element would be — composition
is implicit.

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

`input` projects ctx → use-case input. `output` merges use-case output → new ctx. Both projections may throw
a `DomainError` (e.g. a precondition like `ctx.sprint` being undefined when an upstream step should have set
it) — those throws become `failed` trace entries. Any other throw is a programmer bug and re-propagates.

`leaf` is the only place a chain definition mentions a use case. Everywhere else, chains compose other
elements.

## sequential — composite by default

```ts
sequential('refine', [
  loadSprintLeaf,
  assertDraftLeaf,
  refinePerTicket, // ← itself a sequential; composite is just "an Element"
  exportRequirementsLeaf,
]);
```

Semantics:

- Runs elements in order; threads `ctx` through each.
- On the first `Result.isErr`, aborts the remaining elements (each emits a `skipped` trace entry) and
  returns the error wrapped with the trace up to the failure plus the skipped tail.
- Aborts immediately on `signal.aborted` — the failing-to-start element gets an `aborted` entry; remaining
  elements get `skipped`.
- Emits one trace entry per child element. Composites never report a self-entry.

The implement chain uses a `sequential` of bridge leaves to iterate per-task subchains in topological order;
there is no concurrent fan-out primitive in v0.7.0.

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

`loop` is the implement flow's generator-evaluator primitive. The body is itself a `sequential` of
`generator-leaf → evaluator-leaf → settle-attempt-leaf`; the loop continues until the evaluator passes or the
attempt cap fires.

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
  readonly status: TraceStatus;
  readonly durationMs: number;
  readonly error?: DomainError; // populated when status is 'failed' or 'aborted'
}

type Trace = readonly TraceEntry[];
```

This is the architectural fence: every chain definition has an integration test asserting
`trace.map(s => s.elementName)` for happy + failure paths. Step-order regressions break the build.

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
- **Trace ring buffer**: `runner.trace` is capped at `MAX_TRACE_ENTRIES = 20_000` to bound memory on
  multi-task implement runs. Live subscribers still see every event; the cap only bounds the snapshot
  late subscribers replay from. The TUI's per-task round counter holds a monotonic high-water mark in a
  React ref so the displayed `round N/M` survives eviction.
- **Session scope**: the runner enters the `runWithSession(id, …)` scope before calling
  `element.execute(...)`. Deep adapter code can read `currentSessionId()` to tag logs / signals.

## Examples

### refineFlow

```ts
sequential('refine', [
  loadSprintLeaf,
  assertDraftLeaf,
  linkSkillsLeaf,
  sequential(
    'per-ticket',
    tickets.map((t) =>
      sequential(`ticket-${t.id}`, [
        buildUnitLeaf(/* refinement/<ticket-slug>/ */),
        renderPromptToFileLeaf,
        callRefineInteractiveLeaf, // reads <unit-root>/requirements.md, updates ticket
        saveSprintLeaf,
      ])
    )
  ),
  exportRequirementsLeaf,
  unlinkSkillsLeaf,
]);
```

### implementFlow (per-task gen-eval loop)

```ts
const perTask = sequential('per-task', [
  preflightTaskLeaf,
  startAttemptLeaf,
  withRepoLock(
    sequential('attempt', [
      buildTaskWorkspaceLeaf,
      loop('gen-eval', sequential('round', [generatorLeaf, evaluatorLeaf, finalizeGenEvalLeaf]), {
        shouldStop: (ctx) => ctx.attempt.evaluation?.passed === true,
        maxIterations: ctx.task.maxAttempts ?? settings.harness.maxAttempts,
      }),
      postTaskCheckLeaf,
      commitTaskLeaf,
    ])
  ),
  settleAttemptLeaf,
]);

// Linearise tasks via topologicalReorder over `task.blockedBy` and feed
// the result into a sequential so they run strictly one at a time.
const orderedTasks = topologicalReorder(tasks);

sequential('implement', [
  loadSprintLeaf,
  activateSprintLeaf,
  resolveBranchLeaf,
  ensureProgressFileLeaf,
  setupScriptRunnerLeaf,
  linkSkillsLeaf,
  sequential(
    'execute-tasks',
    orderedTasks.map(() => perTask)
  ),
  flushProgressSinkLeaf,
  unlinkSkillsLeaf,
  transitionSprintToReviewLeaf,
]);
```

## Implementation guidelines

- Each primitive is its own file under `src/application/chain/build/` (one of `leaf.ts`, `sequential.ts`,
  `loop.ts`, `guard.ts`). No barrels.
- The `Element` interface and the helpers (`flattenLeaves`, `checkAborted`, `abortedEntry`,
  `skippedEntry`) live in the parent folder (`element.ts`, `trace.ts`).
- Tests in sibling `*.test.ts` files. A failing test must precisely identify which primitive broke.

## What is **not** in the chain framework

- Use cases — those are `business/<module>/`.
- Flow compositions — those are `application/flows/<flow>/`.
- Provider-specific orchestration — rate-limit retry lives in `integration/ai/providers/_engine/`, the idle
  watchdog there too. Cross-process file locks live in `business/io/` + `integration/io/`. The chain framework
  composes use cases that consume these ports; it does not embed any of them.
