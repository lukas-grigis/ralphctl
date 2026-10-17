---
name: lesson-nonfatal-error-is-path-dependent
description: A leaf's "non-fatal" Result.error is only absorbed by the wave scheduler; the serial path's flat sequential halts on it and skips the epilogue
metadata:
  type: feedback
---

When a fix makes a shared per-task leaf (dependency-gate, a new gate) return `Result.error` instead of
writing, check both launch paths. `runWaves` absorbs any non-aborted/non-rate-limit branch error and keeps
scheduling; the serial flow is one flat `sequential`, so the same error ends the run and skips the
epilogue (save-tasks, review transition).

**Why:** the parallel-only integration test passes while the serial behaviour silently changes from
"block and continue" to "halt". Reachability matters: in the serial queue (topological order) the
trigger is usually dead, so it is a doc/test gap, not a bug.

**How to apply:** for any new error-returning leaf in `per-task-subchain.ts`, grep who consumes the error on
each path (`isFatalChainError`, `sequential` halt) and ask for a serial-path test or a documented
"unreachable because ..." line.

Related: when a fix defers a persisted write (hold `done` until fold), grep every reader of the deferred
state (`worktree-teardown.ts` `readPersistedOutcome`, adopt leaf) and re-read their comments — a docstring
claiming "X can only be an older disk row" often stops being true.
