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
the test fails. Firing unit tests can also pin states production never presents: a guard gated on a condition that
the calibrated plateau predicate has already acted on is unreachable in the composed loop — that is how the two
subordinate plateau leaves were found redundant and removed. Test through the composed loop, not a hand-fed context.

**Loop facts that trip assertions:** sequential composites emit no trace entry, only leaves do, so assert leaf names in
`runner.trace`. `InvalidStateError` is recoverable in `turn-error-policy.ts`: a generator spawn failure becomes a
`self-blocked` exit, not a loop `Result.error`. `Leaf.input()` throws are caught by `runLeaf` and resolve to
`Result.error`.
