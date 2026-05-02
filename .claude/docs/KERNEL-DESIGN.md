# Kernel — Chain Framework

Companion to [ARCHITECTURE.md](./ARCHITECTURE.md). This document is the canonical reference for the chain framework
that lives under `src/kernel/chain/`.

## Goal

The kernel chain framework is the application orchestration layer. It sequences and composes business
use cases. It is **not** business logic. It is closer to a workflow engine (Camunda BPMN, Temporal) than
to a typical "pipeline" abstraction — chains are declarative, composable, and inspectable.

Design constraints:

- **Small surface area.** Six concepts total. Conditionals are deliberately omitted — branching belongs
  inside a use case or inside a chain selected by the caller.
- **Pure TypeScript, zero deps.** Lives in `kernel/`, importable by everything below `application/`.
- **Result-typed.** Every element returns `Result<TCtx, DomainError>`. No throws at the framework
  boundary.
- **Inspectable.** Every element has a `name`. Chain executions emit a step trace
  (`{ stepName, status, durationMs }[]`) consumable by tests and the TUI.
- **Cancelable.** Every `execute` accepts an `AbortSignal`.

## Element

```ts
interface Element<TCtx> {
  readonly name: string;
  execute(ctx: TCtx, signal?: AbortSignal): Promise<Result<TCtx, DomainError>>;
}
```

That is the entire interface. Sequential, Parallel, Retry, OnError, and Leaf all implement it. A chain
is an Element. A sub-chain is just an Element passed where another Element would be — composition is
implicit.

## Leaf — the business seam

`Leaf` is the only element that knows about use cases. It adapts `UseCase.execute(input) → Result<output>`
into `Element.execute(ctx) → Result<ctx>`:

```ts
new Leaf('load-sprint', {
  useCase: loadSprintUseCase,
  input: (ctx) => ({ sprintId: ctx.sprintId }),
  output: (ctx, sprint) => ({ ...ctx, sprint }),
});
```

Leaf is the only place a chain definition mentions a use case. Everywhere else, chains compose other
elements.

## Sequential — composite by default

```ts
new Sequential('refine', [
  loadSprint,
  assertDraft,
  refinePerTicket, // ← itself a Sequential or Parallel; composite is just "an Element"
  exportRequirements,
]);
```

Semantics:

- Runs elements in order; threads `ctx` through each.
- On the first `Result.isErr`, aborts the remaining elements and returns the error wrapped with the
  step trace up to the failure.
- Aborts immediately on `signal.aborted`.
- Emits one trace entry per child element.

## Parallel — fan-out + join

```ts
new Parallel(
  'execute-tasks',
  tasks.map((t) => taskChain(t)),
  {
    concurrency: 4,
    failureMode: 'fail-fast' | 'collect-all',
  }
);
```

Semantics:

- Runs child elements concurrently with the configured concurrency cap.
- `fail-fast` — first error aborts siblings via the shared abort signal.
- `collect-all` — every child runs to completion; the result aggregates errors.
- Context merging: each child receives the same input context; results are merged via a caller-supplied
  reducer (`(ctxs: TCtx[]) => TCtx`). For task fan-out, the reducer typically aggregates per-task
  outcomes into a summary.

## Retry — policy decorator

```ts
new Retry(executeTask, {
  maxAttempts: 3,
  backoff: 'exponential' | 'fixed',
  initialDelayMs: 200,
  retryOn: (err) => err.code === 'rate-limited',
});
```

Semantics:

- Wraps a single Element. Re-runs on `Result.isErr` matching `retryOn`.
- Final attempt's failure propagates with the original error.
- Each attempt emits a trace entry.

## OnError — catch + fallback

```ts
new OnError(executeTask, {
  fallback: markTaskBlocked,
  catchIf: (err) => err.code === 'BranchPreflightError',
});
```

Semantics:

- Wraps a single Element. On `Result.isErr` matching `catchIf`, runs `fallback` with the same context.
- The fallback's result becomes the wrapper's result. (Errors from the fallback propagate.)
- If `catchIf` doesn't match, the original error propagates unchanged.

## Why no Conditional element

Two-way branching always reduces to:

- A use case that decides what to do (and its result drives the next step in the chain), or
- A pre-built chain selected by the caller before chain construction.

Embedding `if/else` as a framework primitive complicates the surface, makes traces less readable, and
encourages logic to leak out of business code. Composite + Leaf cover every case we have today.

## Trace contract

Every chain run returns:

```ts
type ChainTrace = ReadonlyArray<{
  stepName: string;
  status: 'completed' | 'failed' | 'skipped' | 'aborted';
  durationMs: number;
  error?: DomainError;
}>;
```

This is the architectural fence: every chain definition has an integration test asserting
`trace.map(s => s.stepName)` for happy + failure paths. Step-order regressions break the build.

### Progressive emission

`Element.execute(ctx, signal?, onTrace?)` accepts an optional `onTrace(entry)` callback. Each
implementation calls it as steps complete (Leaf — once per use-case call; Sequential / Parallel —
once per child; Retry — once per attempt; OnError — once for the child plus once for the fallback if
invoked). The final returned `ChainTrace` array is the union of those emissions; subscribers via
`ChainRunner.subscribe(...)` receive `step` events live as the chain runs, so live UIs (the TUI
execute view, sessions stream) render the trace as it grows instead of waiting for the chain to
settle. Late subscribers added after a terminal state still receive a synthetic replay of every
step entry plus the matching terminal event, so UI re-attach is lossless.

## Examples

### refineFlow

```ts
new Sequential('refine', [
  new Leaf('load-sprint', loadSprintUseCase, {
    /* … */
  }),
  new Leaf('assert-draft', assertSprintDraftUseCase, {
    /* … */
  }),
  new Leaf('link-skills', linkSkillsUseCase, {
    /* … */
  }),
  new Sequential('per-ticket' /* tickets.map(...) */),
  new Leaf('export-requirements', exportRequirementsUseCase, {
    /* … */
  }),
  new Leaf('cleanup-skills', cleanupSkillsUseCase, {
    /* … */
  }),
]);
```

### executeFlow (per-task with retry + fallback)

```ts
const perTask = new Sequential('per-task', [
  new Leaf('branch-preflight', branchPreflightUseCase, {
    /* … */
  }),
  new Leaf('mark-in-progress', markInProgressUseCase, {
    /* … */
  }),
  new OnError(
    new Retry(
      new Leaf('execute-task', executeTaskUseCase, {
        /* … */
      }),
      { maxAttempts: 2, retryOn: (err) => err.code === 'rate-limited' }
    ),
    {
      fallback: new Leaf('mark-blocked', markBlockedUseCase, {
        /* … */
      }),
    }
  ),
  new Leaf('post-task-check', postTaskCheckUseCase, {
    /* … */
  }),
  new Leaf('evaluate-task', evaluateTaskChain, {
    /* … */
  }), // ← evaluator is itself a Sequential
  new Leaf('mark-done', markDoneUseCase, {
    /* … */
  }),
]);

new Sequential('execute', [
  new Leaf('load-sprint', loadSprintUseCase, {
    /* … */
  }),
  new Leaf('resolve-branch', resolveBranchUseCase, {
    /* … */
  }),
  new Leaf('run-check-scripts', runCheckScriptsUseCase, {
    /* … */
  }),
  new Parallel(
    'execute-tasks',
    tasks.map(() => perTask),
    {
      concurrency: 4,
      failureMode: 'collect-all',
    }
  ),
  new Leaf('feedback-loop', feedbackLoopUseCase, {
    /* … */
  }),
]);
```

## Implementation guidelines

- `Element` is an abstract class with a final `execute()` that handles tracing + abort wiring; subclasses
  override a protected `run()`. This avoids every implementation re-implementing the boilerplate.
- Each element class lives in its own file under `kernel/chain/`:
  `element.ts`, `leaf.ts`, `sequential.ts`, `parallel.ts`, `retry.ts`, `on-error.ts`. No barrel.
- Tests in sibling `*.test.ts` files. A failing test must precisely identify which element broke.

## What is **not** in the kernel

- Use cases (those are `business/`).
- Chain definitions (those are `application/chains/`).
- Provider-specific orchestration (rate-limiting coordinator, mutex queue) — those are
  algorithmic primitives in `kernel/algorithms/`, used by Parallel via configuration but not part of the
  chain framework itself.
