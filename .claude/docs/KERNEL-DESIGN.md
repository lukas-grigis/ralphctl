# Kernel — Chain Framework

Companion to [ARCHITECTURE.md](./ARCHITECTURE.md). This document is the canonical reference for the chain framework
that lives under `src/kernel/chain/`.

## Goal

The kernel chain framework is the application orchestration layer. It sequences and composes business
use cases. It is **not** business logic. It is closer to a workflow engine (Camunda BPMN, Temporal) than
to a typical "pipeline" abstraction — chains are declarative, composable, and inspectable.

Design constraints:

- **Small surface area.** Five concepts total. Conditionals and concurrent fan-out are deliberately omitted —
  branching belongs inside a use case or inside a chain selected by the caller, and every workflow runs strictly
  sequentially.
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

That is the entire interface. Sequential, Retry, OnError, and Leaf all implement it. A chain is an
Element. A sub-chain is just an Element passed where another Element would be — composition is implicit.

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
  refinePerTicket, // ← itself a Sequential; composite is just "an Element"
  exportRequirements,
]);
```

Semantics:

- Runs elements in order; threads `ctx` through each.
- On the first `Result.isErr`, aborts the remaining elements and returns the error wrapped with the
  step trace up to the failure.
- Aborts immediately on `signal.aborted`.
- Emits one trace entry per child element.

`executeFlow` uses a `Sequential` of bridge leaves to iterate per-task chains in topological order;
there is no concurrent fan-out primitive.

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

`Element.execute(ctx, signal?, onTrace?, onCtxUpdate?)` accepts two optional callbacks. Each
implementation calls them as steps complete:

- `onTrace(entry)` — Leaf once per use-case call; Sequential once per child; Retry once per attempt;
  OnError once for the child plus once for the fallback if invoked. The final returned `ChainTrace`
  array is the union of those emissions; subscribers via `ChainRunner.subscribe(...)` receive `step`
  events live as the chain runs, so live UIs render the trace as it grows.
- `onCtxUpdate(ctx)` — Leaf calls this after each successful output merge so `ChainRunner.ctx` stays
  current between steps. Only successful transitions call it; failure paths do not. The TUI execute
  view reads `runner.ctx` to populate the task-list panel without waiting for the chain to settle.

Late subscribers added after a terminal state still receive a synthetic replay of every step entry
plus the matching terminal event, so UI re-attach is lossless.

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

// Linearise tasks via topological sort over `task.blockedBy` and feed
// the result into a Sequential so they run strictly one at a time.
const orderedTasks = topologicalReorder(
  tasks.map((t) => ({ item: t, id: String(t.id), blockedBy: t.blockedBy.map(String) }))
);

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
  new Sequential(
    'execute-tasks',
    orderedTasks.map(() => perTask)
  ),
]);
```

## Implementation guidelines

- `Element` is an abstract class with a final `execute()` that handles tracing + abort wiring; subclasses
  override a protected `run()`. This avoids every implementation re-implementing the boilerplate.
- Each element class lives in its own file under `kernel/chain/`:
  `element.ts`, `leaf.ts`, `sequential.ts`, `retry.ts`, `on-error.ts`. No barrel.
- Tests in sibling `*.test.ts` files. A failing test must precisely identify which element broke.

## What is **not** in the kernel

- Use cases (those are `business/`).
- Chain definitions (those are `application/chains/`).
- Provider-specific orchestration (rate-limiting coordinator, mutex queue, dependency reorder) — those are
  algorithmic primitives in `kernel/algorithms/`, consumed by chain factories at construction time
  (e.g. `executeFlow` calls `topologicalReorder` to linearise tasks) but not part of the chain framework
  itself.
