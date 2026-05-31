---
name: src chain factory pattern
description: Conventions for writing chain factories under src/application/chains/ — pre-loaded data, lean dep view, integration-test step assertions
type: feedback
---

When writing chain factories under `src/application/chains/`:

**Why:** Step counts depend on runtime data (number of tickets, tasks). The factory is pure and synchronous, so the
_caller_ loads data first and passes it through `opts`. The chain's `load-sprint` leaf is for transactional
consistency / resume, not for sizing the chain.

**How to apply:**

1. Each chain factory takes `(deps, opts)` where:
   - `deps` is a `Pick<ChainSharedDeps, ...>` listing only the ports the chain consumes — narrows test deps and
     clarifies the workflow's port surface.
   - `opts` includes pre-loaded data (`pendingTickets`, `tasks`, `sprint`) so `Sequential`/`Parallel` children can be
     sized at construction time.
2. Co-locate the context type (`RefineCtx`, `PlanCtx`, etc.) in the same `<chain>-flow.ts` file as the factory — the
   brief allowed both, and one file is simpler.
3. Each chain has an integration test under `<chain>-flow.test.ts` that asserts
   `result.value.trace.map(t => t.stepName)` for the happy path AND at least one failure path. This is the architectural
   fence — kernel `Parallel` does NOT add an entry for itself, only its children, so test assertions must filter
   accordingly.
4. Inline guard leaves (`assert-draft`, `assert-active`, `assert-tasks-not-empty`) live as private functions inside the
   flow file, not in `chains/leaves/` — they're chain-specific and have no reuse value.
5. Reusable leaves (`load-sprint`, `save-sprint`, `load-tasks`, `save-tasks`, `link-skills`, `unlink-skills`,
   `reorder-tasks`) live under `chains/leaves/` with their own `.test.ts`.
6. Test fakes: `src/application/_test-fakes/create-test-deps.ts` returns a `TestDeps` view glued together from the
   per-port fakes; `fixtures.ts` has `makeSprint`, `makeTicket`, `makeTask`, `makeProject`, `abs(...)`, `slug(...)` etc.
7. The kernel framework swallows `as unknown as KernelError` casts — `DomainError` subclasses (with `code: string`,
   `message: string`, optional `cause`) are structurally compatible with `KernelError`, so just
   `Result.error(new InvalidStateError(...))` works.
8. To wrap a use case as a Leaf: `new Leaf<TCtx, UInput, UOutput>(name, { useCase, input, output })`. The `useCase`
   adapter has shape `{ async execute(input): Promise<Result<UOutput, KernelError>> }` — wrap your real use case inline
   if its signature doesn't match exactly.
