---
name: lesson-real-git-vs-fake-git-runner
description: Assertions about git's residual state need real git; fake GitRunners cannot see them
metadata:
  type: feedback
---

`git worktree remove --force` deletes the worktree directory and its `.git/worktrees/<name>` admin record but NOT the
branch ref. `ralphctl/<sprint>/wt-<taskId>` branches leaked until `cleanupWorktree` called `gitDeleteBranch`. A prune
would not have caught it either (prune cleans admin records, never orphaned refs).

**Why:** this bug class is structurally invisible to every fake-`GitRunner` test. Only
`tests/e2e/flows/implement-parallel-realgit.test.ts` observes what git actually leaves behind.

**How to apply:** reach for real git whenever the assertion is about git's own residual state (refs, stashes,
worktrees, fold/cherry-pick exit codes). In the parallel path `session.cwd` is the worktree path, so a fake provider
must write real files there, not at the sprint dir root. Concurrency claims on `tasks.json` need the real
`FsTaskRepository`, not a stub.
