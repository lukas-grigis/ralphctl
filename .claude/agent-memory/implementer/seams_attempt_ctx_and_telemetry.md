---
name: seams_attempt_ctx_and_telemetry
description: Per-attempt ctx lifecycle in the implement flow — where state resets, how a new ctx field must be classified, the cost-telemetry pipeline, round numbering, and the round display fold
metadata:
  type: project
---

Files: `flows/implement/per-task-subchain.ts`, `flows/implement/sprint-scoped-projection.ts`,
`flows/implement/merge-wave.ts`, `leaves/_shared/attempt-usage-carry.ts`,
`leaves/stamp-role-meta.ts`, `ui/tui/runtime/bucket-task-signals.ts`.

## Classifying a NEW ctx field (do this first)

`CTX_FIELD_CLASS` in `sprint-scoped-projection.ts` is THE exhaustiveness guard: one object literal
keyed over every `ImplementCtx` field, `satisfies Record<keyof ImplementCtx, FieldClass>`, classifying
each on TWO axes — `merge` (`SPRINT` / `PER_TASK` / `SIGNAL_ACCUM`) and `attempt` (`RESET` /
`SETTLE_RESET` / `CARRY`). Adding any field breaks the `satisfies` check until you classify it.

**Heads-up for scoped tasks: adding ANY ctx field forces a touch of this file even when your owned-file
list excludes it.** Flag it to the integrator rather than working around it.

Classification decides how much else you touch:

- **`SPRINT` (run-scoped)** needs THREE sites: the map entry, plus `mergeImplementWave` (carry the field
  verbatim from `base`, so it survives between waves) and `forkCtx` (spread it into each branch's
  `initialCtx`). The guard forces classification, NOT correct carry — miss either body and the field is
  silently dropped in parallel mode while typecheck stays green.
- **`PER_TASK` / `SIGNAL_ACCUM`** need ONLY the map entry: `mergeImplementWave` and `forkCtx`
  intentionally omit those classes (reset between waves / cleared on fork). `priorPostVerifyOutcome` is
  deliberately dropped in `forkCtx` — per-task and run-scoped fields are handled oppositely there.

## Where attempt-scoped state resets — TWO leaves, not one

- **`start-attempt-<id>` (loop body HEAD, entry boundary)** clears verdict/turn/session state:
  `genEvalTurn`, `plateauHistory`, `currentRoundNum`, `lastEvaluation`, `lastVerdict`,
  `lastBlockReason`, `proposedCommitMessage`, `priorGeneratorSessionId`, `priorEvaluatorSessionId`.
- **`progress-journal-<id>` (loop body TAIL, exit boundary)** clears the generator-hint signal
  accumulators: `currentAttemptChanges` / `Decisions` / `Learnings` / `Notes`. It is the last element of
  the attempt-body sequential and runs UNCONDITIONALLY every iteration, so a retried attempt never
  inherits the rejected attempt's hints.
- **`settle-attempt-<id>`** clears only its own fields (`lastVerifyResult`, `lastPreVerifyOutcome`,
  `lastShouldFailAttempt`, `lastCommitSha`, …). It deliberately does NOT touch the signal accumulators
  (progress-journal still has to read them) and does NOT clear cross-task carries like
  `priorPostVerifyOutcome`.

**Why the split works:** the `loop` primitive checks `shouldStop` AFTER the body, so a retry still runs
the full body including progress-journal — the hint reset fires between attempts for free.

**How to apply:** pick the reset site by lifecycle — entry-time verdict/session state → start-attempt;
signals consumed by the journal → progress-journal. Do not assume start-attempt resets everything.

## Cost telemetry pipeline

`Attempt.inputTokens` / `outputTokens` / `durationMs` (all optional, additive) flow through ONE pipeline:

```
ProviderUsage on ProviderOutput (providers/_engine/headless-ai-provider.ts)
  → RoleTurnOutcome.usage (leaves/_shared/run-role-turn.ts)
  → generator + evaluator leaf out-channel (same mutable-accumulator trick as correctiveNudgeCount)
  → attemptUsageCarry (leaves/_shared/attempt-usage-carry.ts, wraps positiveCountCarry)
  → ctx.currentAttempt{InputTokens,OutputTokens,DurationMs}
  → settle-attempt leaf projection → SettleAttemptProps.usage
  → recordRunningAttemptUsage (domain/entity/task-attempts.ts), stamped BEFORE the terminal transition
```

- The adapter collection seam is `emitTokenUsage(...)`, which RETURNS the payload it published; each
  headless adapter returns it from `emitProviderTokenUsage`. **A new provider must honour that return
  type.**
- `durationMs` is harness-measured AI wall-clock summed over spawns — deliberately NOT
  `finishedAt - startedAt`, which is already derivable. Say so in any doc or prompt that names it.
- The three accumulators are `{ merge: SIGNAL_ACCUM, attempt: CARRY }`. **`CARRY` is load-bearing:**
  `settle-attempt` must still read them and it runs BEFORE `progress-journal` (which clears the whole
  SIGNAL_ACCUM bucket). `RESET` would blank them before settle ever saw them.
- **Absent ≠ 0 everywhere:** `positiveCountCarry` skips zero deltas and `recordAttemptUsage` skips
  non-finite / negative values, so "provider reported nothing" stays distinguishable from "cost nothing".
- Known gap, not an accident: spawns outside the two gen-eval role turns (best-of-N candidates,
  `reproduce`) call `provider.generate` directly and do not fold their usage.

## Round numbering and the role-meta sidecar

`resolveRoundNumLeaf` runs FIRST in every gen-eval iteration, calls `nextRoundNum(workspaceRoot)`, and
stamps `ctx.currentRoundNum`. Both stamp leaves and both role leaves then READ that field — **none of
them call `nextRoundNum` themselves.** Centralising the claim in one leaf guarantees the same N across
stamp + generator + evaluator within a turn and avoids a race between sibling disk reads.

`stampGeneratorRoleMetaLeaf` / `stampEvaluatorRoleMetaLeaf` run BEFORE each spawn and write
`<sprintDir>/implement/<task-id>/rounds/<N>/<role>/role-meta.json` (not `meta.json`), returning ctx
unchanged. Shape: `{ role, provider, model, effort: string|null, attemptN, roundN, startedAt,
escalatedFromModel: string|null }`. Forward-only — pre-existing sprint dirs are not backfilled.

**Why it exists:** role attribution otherwise lives only in `settings.json`, which mutates, so historical
attribution was lost whenever a user edited settings between runs. **Read `role-meta.json` rather than
re-querying settings** for any new spawn-side concern needing per-round attribution.

## Per-attempt round display

`TaskBucket.genEvalRound` is MONOTONIC across the whole task (the on-disk `rounds/<N>/` dir is shared by
every attempt; `nextRoundNum = max(existing)+1`), while `genEvalMaxRounds` (`maxTurns`) caps a SINGLE
attempt — so rendering the raw ratio overshot on 2nd+ attempts (`round 4/3`).

`perAttemptRound(genEvalRound, maxTurns)` (`bucket-task-signals.ts`, `@public`) folds the global round
into `{ attemptN, roundInAttempt }`, clamped so `roundInAttempt ∈ 1..maxTurns`. Both render surfaces —
`execute-view-internals/header-card.tsx` and `tasks-panel-internals/task-row.tsx` — call it **at render
time, not on the bucket**: the round overlay in `use-bucketed-tasks.ts` overrides
`genEvalRound`/`genEvalMaxRounds` from the authoritative `task-round-started` tracker AFTER
`bucketTaskSignals` runs, so anything baked into the bucket would be stale against the trace-counted
round.

`genEvalMaxAttempts` (the `/X` cap) is wired end-to-end: `maxAttempts?: number` on `SessionDescriptor` +
`register(...)`, returned by `launchImplement` from `settings.harness.maxAttempts`, spread into
`bucketTaskSignals`'s `BucketOptions` by `use-bucketed-tasks.ts`. The round overlay patches only
`genEvalRound`/`genEvalMaxRounds`, so the attempts cap survives. Render surfaces gate the proactive
attempt-1 display on `maxAttempts > 1`.

Related: [[seams_plateau_and_turn_errors]], [[seams_verify_gates]], [[seams_parallel_runner_architecture]].
