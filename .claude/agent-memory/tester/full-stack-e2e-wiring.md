---
name: full-stack-e2e-wiring
description: tests/e2e/full-stack wiring patterns — implement launcher bypasses app.deps.provider, TUI mount plumbing for ink-testing-library, sprint pre-setup, workspace-mutating fake provider
metadata:
  type: feedback
---

`tests/e2e/full-stack/implement-review-close.test.ts` and
`tests/e2e/full-stack/sprint-lifecycle.test.ts` — 7+ tests.

**R1 constraint (critical)**: the implement LAUNCHER bypasses `app.deps.provider` — it builds
per-role providers from settings. For full-stack tests, construct `ImplementDeps` manually from
`app.deps` sub-repos + the fake provider pair; do NOT set `app.deps.provider`.

**ImplementDeps harness field defaults**: `plateauThreshold`, `escalateOnPlateau`,
`escalationMap` all live in `config.harness` — pass them in explicitly when testing
escalation/plateau arcs.

**TUI mount in ink-testing-library** —
`<App deps storage buses sessions queue logLevelGate initialView>`:

- `buses.log` must be `BusSink<LogEvent>` (typed) — `createBusSink<LogEvent>({ maxEntries: N })`.
- `buses.harness` is `BusSink<HarnessSignal>`.
- Import `LogEvent` from `@src/business/observability/events.ts`.
- `createSessionManager` from `@src/application/ui/tui/runtime/session-manager.ts`.
- `createPromptQueue` from `@src/application/ui/tui/prompts/prompt-queue.ts`.
- `createLogLevelGate` from `@src/business/observability/log-level-filter.ts`.

**Sprint pre-setup for implement flow**: persist both `sprint.json` AND `execution.json` (with the
branch already set via `setExecutionBranch`) so `resolveBranchLeaf` does not stall on an
interactive prompt.

**`createWorkspaceMutatingFakeProvider`**: lives at
`tests/fixtures/workspace-mutating-fake-provider.ts`. Extends `FakeAiProviderScript` with a
`fileWrites` map. The inner `createFakeAiProvider` handles signal dispatch; the wrapper writes
files before delegating. Split type-only imports from value imports to satisfy lint.

**`blockKind` values**: `'own'` for tasks that emitted a task-blocked signal; `'upstream'` for
tasks blocked by a dependency gate because a prerequisite is not done.
