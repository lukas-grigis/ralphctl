---
name: budget-raised-without-signal-threading
description: When a fix lengthens a timeout and says "so it never blocks a cancel", grep every call site of the new budget constant for a signal; only the sites the report names usually got one
metadata:
  type: feedback
---

A fix that raises a per-verb timeout (30s to 10 min) and adds an optional `signal` to the runner will
usually thread the signal through only the verbs the original finding named (commit, push). The other
verbs that received the same constant (checkout, worktree add, merge --ff-only, cherry-pick, stash) keep
no signal, so a cancel waits out the longer budget whenever git or its hook hangs.

**Why:** a hung hook used to fail in 30s; with a bigger budget and no signal it holds the run for the
whole budget. Leaves convert `signal.aborted` to `AbortError` after the use case returns, but only once
it returns.

**How to apply:** grep the new constant (`GIT_HOOK_TIMEOUT_MS`, `GIT_BULK_TIMEOUT_MS`) and list the sites
without a `signal`; compare with the report's "never blocks a cancel" claim. Also check each new budget
has a test that pins it per verb, since a dropped `timeoutMs` option is invisible to the suite.

**Exception to check before flagging:** a verb whose callers run on the abort/cleanup path (stash push/pop,
worktree remove in teardown) must NOT take the signal: `runGitOnce` returns an error without spawning when the
signal is already aborted, so the cleanup would silently skip. Confirm the callers (grep) and that the budget
is pinned, then accept "no signal" as documented. For the hook verbs that do take it, check the half-done
state a kill leaves (ff landed, cherry-pick mid-sequence, worktree add) is handled by the caller.

Related: [[lesson_partial_wiring_of_general_seam]].
