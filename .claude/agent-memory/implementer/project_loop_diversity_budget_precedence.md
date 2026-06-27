---
name: loop-diversity-budget-precedence
description: gen-eval loop-diversity guard must NOT pre-empt the final budgeted turn — budget-exhausted wins over plateau when no turns remain
metadata:
  type: project
---

The loop-diversity guard in `src/application/flows/implement/leaves/gen-eval-loop.ts`
(`loop-diversity-check-<taskId>` leaf, last child of the `evaluator-step-<id>` sequential)
fingerprints each evaluator turn's failed-dimension set and exits the gen-eval loop via a
`plateau` exit when the last `DIVERSITY_WINDOW_SIZE` (3) fingerprints are identical.

**Invariant:** a run where every turn fails from the very start (never any progress) must always
exit as `budget-exhausted`, never `plateau`. The guard reads `ctx.genEvalTurn` (turnsUsed) and
`deps.readConfig().maxTurns`; when `turnsUsed >= Math.max(1, maxTurns)` it returns
`shouldExit: false` so `finalize-gen-eval` synthesises the `budget-exhausted` exit instead.

**Why:** when maxTurns == windowSize (e.g. e2e "exhausted budget: every turn fails", maxTurns=3,
window=3), the diversity collapse fingerprint fills on the final budgeted turn — both budget and
diversity would fire, but the diversity leaf runs inside the turn body BEFORE the loop's
`shouldContinue` re-checks budget, so it would set `lastExit: plateau` first and steal the exit.
The fix: diversity only fires while turns still remain to reclaim via early escalation.

**How to apply:** read the budget from the same `readConfig()` the loop's `shouldContinue` uses
(not a captured constant) so a runtime config change can't diverge the two. If you ever change the
diversity-exit kind or add another in-turn terminal guard, preserve this budget-precedence ordering.

Related: [[project_escalation_gate_broadened.md]] (finalize escalation on plateau/budget/malformed),
[[project_recoverable_turn_error_policy.md]].
