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
9. **DESIGN-SYSTEM.md § 6.1** — new global keys not listed; added `b`, `g`, `y` in prior pass; `P`, `S`
   added in 2026-05-21 session (cross-project pickers).
10. **REQUIREMENTS.md** — many [x] items not ticked even after code shipped.
11. **DESIGN-SYSTEM.md** — missing responsive breakpoints section entirely until 2026-05-21 session;
    breakpoints shipped as named constants but the design doc had no vocabulary for them.
12. **CLAUDE.md § Workflows & State — Execute view widths** — hardcoded column numbers become stale when
    the breakpoint system evolves; always express as named breakpoints now.
13. **KERNEL-DESIGN.md — Element interface** — any interface field additions (like `label?`) need to be
    reflected in both the code block and the prose; `TraceEntry` too.

14. **CLAUDE.md § Performance & Limits — "Implement is strictly sequential"** — was false after
    parallel execution landed; task-graph validation wiring note also stale. Always re-read this
    section after any implement-flow structural change.
15. **ARCHITECTURE.md § Future Work** — tends to list items that have already shipped without
    being removed; always cross-check against git log.
16. **REQUIREMENTS.md § Things deliberately deferred** — same pattern: deferred items stay listed
    after they ship. Check against the commit log for each feature branch.
17. **ARCHITECTURE.md § Data Models — Task.dependsOn field name** — field was `blockedBy` in older
    versions; docs had not been updated. Always grep the entity source for field names before writing.
18. **ARCHITECTURE.md § Harness Signals table — SkillSuggestionsSignal** — said "no flow consumer
    yet" but the readiness flow now acts on it. Signal table entries often lag behind flow changes.

**Why:** These areas cluster around the observability/TUI surface, the chain framework primitives,
and the implement-flow — all of which evolve in every sprint. Items 14–18 specifically from the
`feat/parallelism-wiring-memory` drop (2026-05-30).

**How to apply:** On the next feature drop, check these sections first before reading git log. In
particular, always grep `events.ts` for the AppEvent union (compare to every doc that lists it),
diff `element.ts` + `trace.ts` against KERNEL-DESIGN.md, and re-read CLAUDE.md § Performance &
Limits after any implement-flow structural change.
