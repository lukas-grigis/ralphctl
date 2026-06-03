---
name: per-attempt-round-display
description: Live round counter folds the monotonic global round into per-attempt coords via perAttemptRound; genEvalMaxAttempts plumbing now fully wired (descriptor→bucket→render)
metadata:
  type: project
---

`TaskBucket.genEvalRound` is MONOTONIC across the whole task (the on-disk `rounds/<N>/` dir is shared
by every attempt — `nextRoundNum = max(existing)+1`), while `genEvalMaxRounds` (`maxTurns`) caps a
SINGLE attempt. Rendering the raw ratio overshot on 2nd+ attempts (`round 4/3` at default maxAttempts=3).

Fix: `perAttemptRound(genEvalRound, maxTurns)` in `src/application/ui/tui/runtime/bucket-task-signals.ts`
(exported, `@public`) folds the global round into `{ attemptN, roundInAttempt }`, clamped so
`roundInAttempt ∈ 1..maxTurns` — never overshoots. Both render surfaces call it at render time:
`execute-view-internals/header-card.tsx` (focus row) and `tasks-panel-internals/task-row.tsx` (inline).

**Why render-time, not on the bucket:** the round overlay in `use-bucketed-tasks.ts` overrides
`genEvalRound`/`genEvalMaxRounds` from the authoritative `task-round-started` tracker AFTER
`bucketTaskSignals` runs. Any per-attempt fields baked into the bucket would be stale against the
trace-counted round. Computing at render time from the post-overlay values keeps it correct.

**Gap NOW CLOSED (2026-06-03, ui-ux-stabilization):** `genEvalMaxAttempts` (the `/X` cap) is fully
wired end-to-end. `maxAttempts?: number` lives on `SessionDescriptor` + the `register(...)` input
(`session-manager.ts`, mirroring `maxTurns`); `launchImplement` (`ui/shared/launch/implement.ts`)
returns `maxAttempts: settings.harness.maxAttempts` alongside `maxTurns`; `use-bucketed-tasks.ts`
spreads `descriptor.maxAttempts` into `bucketTaskSignals`'s `BucketOptions`. `bucketTaskSignals`
already set `genEvalMaxAttempts` from `opts.maxAttempts`, and the round overlay only patches
`genEvalRound`/`genEvalMaxRounds` so the attempts cap is preserved untouched. Render surfaces
(`execute-view-internals/header-card.tsx`, `components/tasks-panel-internals/task-row.tsx`) gate the
proactive attempt-1 display on `maxAttempts > 1`, so `attempt 1/X` now shows live when a multi-attempt
budget is configured. Tested at the descriptor→bucket seam in
`tests/integration/application/ui/tui/views/use-bucketed-tasks.test.tsx`.

**Why:** audit L4 / north-star "operator always knows what state they're in".
