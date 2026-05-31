---
name: recoverable-turn-error-policy
description: gen-eval turn errors block the task instead of aborting the run, except Aborted/RateLimit which propagate
metadata:
  type: project
---

The gen-eval `loop` primitive propagates any body `Result.error`, which aborts the whole per-task subchain AND every
remaining todo task. To stop one bad AI turn from taking down the entire implement run, `runGeneratorTurnUseCase` /
`runEvaluatorTurnUseCase` (in `src/business/task/`) classify a failed `callImplement`/`callEvaluate` via
`isRecoverableTurnError(err)` (in `src/business/task/turn-error-policy.ts`):

- `Aborted` / `RateLimit` codes → still `Result.error` (propagate, abort the run). Aborted = user cancel (CLAUDE.md
  transparent-propagation rule); RateLimit = adapter already exhausted 429 retries.
- everything else (ParseError schema/json, InvalidStateError signals-missing / spawn-exit-N, MigrationGapError) →
  `Result.ok` with a `self-blocked` exit. The validator's message is preserved in the block reason.

**Why:** non-Claude providers (codex/copilot) trip the strict signals.json contract far more often than Claude,
especially the evaluator (default evaluator is codex).

**How to apply:** The evaluator's recoverable failure MUST reach a `blocked` task, NOT `malformed` — `settle-attempt`
treats `malformed` (no blockedReason) as done-with-warning, which would mark an UNGRADED change `done`.
`EvaluatorTurnExit` was widened with a `self-blocked` variant (it's a subset of `GenEvalExit`). The evaluator leaf maps
`out.exit` onto `ctx.lastExit`; `finalize-gen-eval`'s `mapExit` turns `self-blocked` into
`{verdict:'failed', blockedReason}`, and `commit-task` is guarded on `lastBlockReason === undefined` so the ungraded
change is never committed. See [[project_implement_role_meta_sidecar]] for the round/role ctx seams.
