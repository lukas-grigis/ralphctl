---
name: project-attempt-cost-telemetry-seam
description: The provider→attempt cost pipeline (inputTokens/outputTokens/durationMs) — ProviderOutput.usage → RoleTurnOutcome → ctx SIGNAL_ACCUM accumulators → settle → domain; why the accumulators are CARRY not RESET
metadata:
  type: project
---

Per-attempt cost telemetry (`Attempt.inputTokens` / `outputTokens` / `durationMs`, all optional/additive)
is persisted through ONE pipeline, landed on `feature/harness-outcome-rollup` (2026-08-14):

`ProviderUsage` on `ProviderOutput` (`providers/_engine/headless-ai-provider.ts`)
→ `RoleTurnOutcome.usage` (`implement/leaves/_shared/run-role-turn.ts`)
→ generator + evaluator leaves' out-channel (same mutable-accumulator trick as `correctiveNudgeCount`)
→ `attemptUsageCarry` (`_shared/attempt-usage-carry.ts`, wraps `positiveCountCarry`)
→ `ctx.currentAttempt{InputTokens,OutputTokens,DurationMs}`
→ `settle-attempt` leaf projection → `SettleAttemptProps.usage` → `recordRunningAttemptUsage`
(`domain/entity/task-attempts.ts`) stamped BEFORE the terminal transition.

**Why:** the counts previously existed only as ephemeral `TokenUsageEvent`s for the TUI; the design review
insisted on raw counts only (no pricing, no aggregation changes) and independent revertibility.

**How to apply:**

- The counter-collection seam in the adapters is `emitTokenUsage(...)`, which now RETURNS the payload it
  published; each of the 4 headless adapters just `return`s it from `emitProviderTokenUsage`. Adding a 5th
  provider means honouring that return type.
- `durationMs` is harness-measured AI wall-clock summed over spawns — deliberately NOT
  `finishedAt - startedAt` (that is already derivable). Say so in any doc/prompt that names it.
- The three ctx accumulators are classified `{ merge: SIGNAL_ACCUM, attempt: CARRY }` in
  `sprint-scoped-projection.ts`. `CARRY` is load-bearing: `settle-attempt` must still READ them, and it runs
  BEFORE `progress-journal` (which clears the whole SIGNAL_ACCUM bucket). Classifying them `RESET` would
  blank them before settle ever sees them.
- Absent ≠ 0 everywhere: `positiveCountCarry` skips zero deltas and `recordAttemptUsage` skips non-finite /
  negative values, so "provider reported nothing" stays distinguishable from "cost nothing".
- Spawns outside the two gen-eval role turns (best-of-N candidates, `reproduce`) call
  `provider.generate` directly and do NOT fold their usage — a known gap, not an accident.

Related: [[project_recoverable_turn_error_policy]], [[project_attempt_scoped_ctx_reset_seam]].
