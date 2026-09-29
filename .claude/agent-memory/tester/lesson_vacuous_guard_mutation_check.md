---
name: lesson-vacuous-guard-mutation-check
description: A test whose guard can never fail proves nothing; mutate the code to see it go red
metadata:
  type: feedback
---

`if (result.ok && result.value.warning?.kind === 'plateau') { expect… }` passes when the branch never runs. Assert both
the presence and the value of every field a mapping produces (`finalize-gen-eval` `mapExit`: verdict, warning,
blockedReason; `shouldFailAttempt` comes from the escalation policy, not `mapExit`).

**How to apply:** for each new fence, temporarily break the code under test (negate a gate, drop the guard) and confirm
the test fails. Firing unit tests can also pin states production never presents: `entropy-check` and
`loop-diversity-check` cannot fire in the composed gen-eval loop because `windowIsHardStall` is exactly when the
calibrated plateau predicate already set `ctx.lastExit`. Their `subordination to the calibrated predicate` describes and
the `gen-eval-loop.test.ts` "genuine stall → threshold" test pin that; do not weaken them.

**Loop facts that trip assertions:** sequential composites emit no trace entry, only leaves do, so assert leaf names in
`runner.trace`. `InvalidStateError` is recoverable in `turn-error-policy.ts`: a generator spawn failure becomes a
`self-blocked` exit, not a loop `Result.error`. `Leaf.input()` throws are caught by `runLeaf` and resolve to
`Result.error`.
