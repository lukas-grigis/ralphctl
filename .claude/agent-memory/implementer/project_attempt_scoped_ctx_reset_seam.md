---
name: attempt-scoped-ctx-reset-seam
description: implement attempt-scoped ctx state resets in TWO places — start-attempt (entry) and progress-journal (exit); which field resets where matters
metadata:
  type: project
---

In the implement flow's per-task attempt loop (`per-task-subchain.ts`), attempt-scoped ctx state
is reset across attempt boundaries in TWO distinct leaves — know which is which before adding state:

- **`start-attempt-<id>` (loop body HEAD, entry boundary)** clears verdict/turn state:
  `genEvalTurn`, `plateauHistory`, `currentRoundNum`, `lastEvaluation`, `lastVerdict`,
  `lastBlockReason`, `proposedCommitMessage`, `priorGeneratorSessionId`, `priorEvaluatorSessionId`.
- **`progress-journal-<id>` (loop body TAIL, exit boundary)** clears the GENERATOR_HINTS signal
  accumulators: `currentAttemptChanges` / `currentAttemptDecisions` / `currentAttemptLearnings` /
  `currentAttemptNotes`. It runs UNCONDITIONALLY every iteration (last element of the attempt-body
  sequential, no guard), so a retried attempt never inherits the rejected attempt's hints.
- **`settle-attempt-<id>`** clears its own per-attempt fields (lastVerifyResult, lastPreVerifyOutcome,
  lastShouldFailAttempt, lastCommitSha, …) but deliberately does NOT touch the signal accumulators
  (leaves them for progress-journal to read) and does NOT clear cross-task carries like
  `priorPostVerifyOutcome`.

**Why:** the four signal accumulators must survive settle so progress-journal can render them, then be
cleared before the next attempt. Because the `loop` primitive checks `shouldStop` AFTER the body runs,
a retry (task settled in_progress) still runs the full body including progress-journal — so the reset
fires between attempts for free. This is the answer to "do GENERATOR_HINTS reset on the retry path?"
(gen-eval-speed T7): yes, already, via progress-journal — no fix needed.

**How to apply:** when adding new attempt-scoped ctx state, pick the reset site by lifecycle — entry-time
verdict/session state → start-attempt; signals consumed by the journal → progress-journal. Don't assume
start-attempt resets everything. Related: [[project_recoverable_turn_error_policy]],
[[project_per_attempt_round_display]].
