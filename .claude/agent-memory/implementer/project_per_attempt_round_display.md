---
name: per-attempt-round-display
description: Live round counter folds the monotonic global round into per-attempt coords via perAttemptRound; genEvalMaxAttempts plumbing is half-wired
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

**Half-wired gap (deferred / sibling-stream):** `genEvalMaxAttempts` (the `/X` cap) is carried on the
bucket only when `bucketTaskSignals` is called with `opts.maxAttempts`. That requires
`use-bucketed-tasks.ts` to pass `descriptor.maxAttempts`, which requires `maxAttempts` on
`SessionDescriptor` + the register input (`session-manager.ts`) + the launcher. Until that lands the
attempt CAP won't render live — but the overshoot fix is fully live (round is always folded). The
attempt counter shows bare `attempt N` (no `/X`) when the cap is unknown.

**Why:** audit L4 / north-star "operator always knows what state they're in". **How to apply:** if you
later thread `maxAttempts` onto the descriptor, pass it through `bucketTaskSignals(opts.maxAttempts)` —
the render surfaces already consume `genEvalMaxAttempts`.
