---
name: parallel-implement-realgit-e2e
description: implement-parallel-realgit.test.ts proves the parallel worktree path against a REAL git repo — worktree branch-leak bug history + session.cwd provider pattern
metadata:
  type: feedback
---

`tests/e2e/flows/implement-parallel-realgit.test.ts` — proves the parallel path against a REAL git
repo. **Real bug found (since FIXED via `gitDeleteBranch`; assertion now green):**
`gitWorktreeRemove --force` left the `wt-*` branch refs behind.

Happy-path assertions that DID pass: runner `completed`, all 3 tasks `done`, sprint `review`, 4
commits on the sprint branch (wave order A/B before C), worktree DIRECTORIES cleaned up.

Provider pattern: `session.cwd` is the worktree path in the parallel path — write real files
there, not at the sprint dir root.
