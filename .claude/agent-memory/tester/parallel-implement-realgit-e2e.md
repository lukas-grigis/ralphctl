---
name: parallel-implement-realgit-e2e
description: implement-parallel-realgit.test.ts proves the parallel worktree path against a REAL git repo — the branch-leak bug it caught and the session.cwd provider pattern
metadata:
  type: feedback
---

`tests/e2e/flows/implement-parallel-realgit.test.ts` — proves the parallel path against a REAL git
repo. **Real bug found (since FIXED via `gitDeleteBranch` in `cleanupWorktree`; assertion now
green):** `git worktree remove --force` deletes the worktree directory and the `.git/worktrees/<name>`
admin record but NOT the branch ref, so `ralphctl/<sprint>/wt-<taskId>` branches leaked. A prune step
would not have caught it either — prune only cleans admin records, never orphaned refs.

**Durable lesson:** this class of bug is structurally invisible to every fake-`GitRunner` unit test —
only a real-git e2e can observe what git actually leaves behind. Reach for real git whenever the
assertion is about git's own residual state.

Happy-path assertions that DID pass: runner `completed`, all 3 tasks `done`, sprint `review`, 4
commits on the sprint branch (wave order A/B before C), worktree DIRECTORIES cleaned up.

Provider pattern: `session.cwd` is the worktree path in the parallel path — write real files
there, not at the sprint dir root.
