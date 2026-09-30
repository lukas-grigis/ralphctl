---
name: seams_plateau_and_turn_errors
description: gen-eval loop seams — the count-based plateau predicate and its exemptions, and which turn errors block versus propagate
metadata:
  type: project
---

Files: `business/task/plateau-detection.ts`, `business/task/turn-error-policy.ts`,
`application/flows/implement/leaves/gen-eval-loop.ts`.

## The plateau predicate is COUNT-based, not identical-set

`computePlateauVerdict` flags a stall when the failed-dimension COUNT never DECREASES across the window
AND the current turn still has failures. The legacy identical-SET check is gone — so rotating WHICH
dimension fails each turn does NOT keep the predicate quiet: the count stays constant (1,1,1) → stall →
plateau exit at `threshold` turns.

Two exemptions, consulted in order and only once a stall is detected:

1. **critique-shift** — the current critique's max trigram-Jaccard against every prior in the window is
   `< 0.5` → `{kind:'progress'}`, loop continues. This is the reliable lever for keeping a loop running
   in a test.
2. **work-product-changed** — `changedFilesHash` differs from every prior in the window →
   `{kind:'warning'}`, capped at `WARNING_SOFTEN_CAP=2` consecutive softenings, then it fires anyway.

## One plateau detector — no in-loop guard leaves

The evaluator turn's `computePlateauVerdict` (windowed by `plateauWindowSize`) is the only plateau detector.
The former `loop-diversity-check` / `entropy-check` leaves and `settings.harness.entropyPlateauDetector` were
removed as strictly subordinate to it; `PlateauSource` still lists `diversity` / `entropy` only so old persisted
attempts parse. A hard stall always exits with `source: 'threshold'`.

**To drive the loop across N turns with no plateau exit**, the scripted evaluator must give a genuinely dissimilar
critique each turn (pairwise Jaccard < 0.5, distinct full sentences) so the count-based predicate is exempted via
critique-shift. An empty/stub gitRunner yields an identical `changedFilesHash` every turn, so the work-product
exemption never helps.

## Turn errors: block the task, don't take down the run

The `loop` primitive propagates any body `Result.error`, which would abort the whole per-task subchain AND
every remaining todo task. So `runGeneratorTurnUseCase` / `runEvaluatorTurnUseCase` classify a failed
`callImplement` / `callEvaluate` via `isRecoverableTurnError(err)` (`turn-error-policy.ts`, defined as
`!isFatalChainError(err)`):

- **`Aborted` / `RateLimit`** → still `Result.error`, propagate and abort the run. Aborted is user cancel
  (the transparent-propagation rule); RateLimit means the adapter already exhausted its 429 retries.
- **`ProcessCrash`** (watchdog kill / spawn crash / non-zero exit with no signals.json) → a `crashed` exit
  on BOTH roles. `crashed` retries within `maxAttempts` and deliberately leaves `lastBlockReason` unset,
  so the commit-task guard stays open and the retry starts from the generator's committed work.
- **everything else** (ParseError schema/json, InvalidStateError signals-missing / spawn-exit-N,
  MigrationGapError) → `Result.ok` with a `self-blocked` exit, preserving the validator's message as the
  block reason.

**Why it matters:** non-Claude providers trip the strict signals.json contract far more often than
Claude, and the default evaluator is codex.

**The evaluator's recoverable failure MUST reach a `blocked` task, never `malformed`** —
`settle-attempt` treats `malformed` (no blockedReason) as done-with-warning, which would mark an UNGRADED
change `done`. `EvaluatorTurnExit` is a subset of `GenEvalExit` and carries both the `crashed` and
`self-blocked` variants; the evaluator leaf maps `out.exit` onto `ctx.lastExit`, `finalize-gen-eval`'s
`mapExit` turns `self-blocked` into `{verdict:'failed', blockedReason}`, and `commit-task` is guarded on
`lastBlockReason === undefined` so the ungraded change is never committed.

Related: [[seams_escalation_ladder]], [[seams_attempt_ctx_and_telemetry]].
