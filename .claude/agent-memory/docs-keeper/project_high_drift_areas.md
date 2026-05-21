---
name: project_high_drift_areas
description: Which doc sections drift fastest after a big feature drop — where to look first
metadata:
  type: project
---

Based on the P0–P4 harness overhaul audit (2026-05-21), sections that had the most stale claims:

1. **CLAUDE.md § Architecture — EventBus variant list** — new events (TaskRoundStarted, TokenUsageEvent,
   BannerShow/Clear, MemoryPressureEvent, ChainLogDegradedEvent) accumulated without doc updates.
2. **CLAUDE.md § Performance & Limits — trace ring buffer value** — had `20_000` but code is `5_000` in
   `src/application/chain/run/runner.ts` (`MAX_TRACE_ENTRIES`). CLAUDE.md now reflects `5_000`.
3. **CLAUDE.md § Security & Safety — file-based AI provider contract** — said `sessionId` files "now"
   written but didn't describe the path (`rounds/<N>/<role>/sessionId`).
4. **ARCHITECTURE.md § Storage layout** — missing `decisions.log`, `outcome.md`, and the flat
   `rounds/<N>/` tree that replaced the old `{generator,evaluator}/` structure documented at the top level.
5. **ARCHITECTURE.md § Data Models — SprintExecution** — said `setupRunAt (map)` but it's now `setupRanAt`
   (typed array of `SetupRun` structs).
6. **ARCHITECTURE.md § Harness Signals table** — `ContextCompactedSignal` added but table not updated.
7. **KERNEL-DESIGN.md — implementFlow example** — `flushProgressSinkLeaf` removed, `preTaskCheckLeaf` and
   `postTaskCheckLeaf` added, `ensureProgressFileLeaf` / `writeProgressSnapshotLeaf` semantics changed.
8. **DESIGN-SYSTEM.md § 4.3** — entire new class of Execute-view components (TokenBudgetCard,
   BaselineHealthCard/Chip, StatusBanner, MultiFlowStrip, EvaluatorFailurePanel, ProgressOverlay,
   CancelScopeOverlay) not documented.
9. **DESIGN-SYSTEM.md § 6.1** — new global keys (`b`, `g`, `y`) not listed.
10. **REQUIREMENTS.md** — many [x] items not ticked even after code shipped.

**Why:** These areas cluster around the observability/TUI surface, which evolves in every sprint.

**How to apply:** On the next feature drop, check these sections first before reading git log. In
particular, always grep `events.ts` for the AppEvent union and compare to every doc that lists it.
