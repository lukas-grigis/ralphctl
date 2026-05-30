---
name: project_parallel_worktree_branch_leak_bug
description: RESOLVED 2026-05-30 — gitWorktreeRemove left wt-* branch refs behind; fixed by gitDeleteBranch in cleanupWorktree
metadata:
  type: project
---

## Bug: `gitWorktreeRemove` leaves `ralphctl/<sprint>/wt-<taskId>` branch refs behind

**STATUS: RESOLVED (2026-05-30).** Fixed by adding `gitDeleteBranch` to `git-operations.ts` and
calling it best-effort in `cleanupWorktree` after `gitWorktreeRemove` (commit `211ec057`). The e2e
assertion is now GREEN. The lesson stands: a real-git e2e caught what every fake-`GitRunner` unit
test structurally could not. Original analysis preserved below.

**Found by:** `tests/e2e/flows/implement-parallel-realgit.test.ts` happy-path assertion (2026-05-30)

**What fails:** After a successful parallel implement run, `git branch -a` still shows 3 local branches:

- `ralphctl/<sprint-id>/wt-<taskA-id>`
- `ralphctl/<sprint-id>/wt-<taskB-id>`
- `ralphctl/<sprint-id>/wt-<taskC-id>`

`git worktree list` correctly shows only the main worktree (the directory cleanup works), but
the branch refs created by `git worktree add -b <ref> <path>` are never deleted.

**Root cause:** `cleanupWorktree()` in `src/application/flows/implement/wave-branch.ts` calls
`gitWorktreeRemove(runner, repoRoot, worktreePath)` which runs `git worktree remove --force <path>`.
That command removes the worktree DIRECTORY and the `.git/worktrees/<name>` admin record,
but git does NOT automatically delete the associated branch ref.

**What the contract requires (CLAUDE.md, T6 design):**

> "Worktrees were created during the run and cleaned up after
> (`git worktree list` shows none left; the `ralphctl/<sprint>/wt-*` refs are gone)."

**Fix:** After `gitWorktreeRemove` succeeds in `cleanupWorktree()`, add:

```typescript
await runner.run(repoRoot, ['branch', '-D', branchRef]);
```

where `branchRef` is already in scope in `withWorktree` (it's the `branchRef` parameter
passed to `gitWorktreeAdd`). Treat a non-zero exit as best-effort (same pattern as
the rest of `cleanupWorktree`).

Alternatively: add `gitDeleteBranch(runner, repoRoot, branchName): Promise<Result<void, StorageError>>`
to `src/integration/io/git-operations.ts` and call it from `cleanupWorktree`.

**File: line:**

- `src/application/flows/implement/wave-branch.ts` — `cleanupWorktree()` function (~line 227)
- `src/integration/io/git-operations.ts` — `gitWorktreeRemove()` (~line 350) — NOT the right fix here; the issue is the caller not deleting the branch afterward.

**Test status:** RESOLVED — `cleanupWorktree` now calls `gitDeleteBranch` (best-effort) after the
worktree remove; the e2e assertion in `tests/e2e/flows/implement-parallel-realgit.test.ts` passes.

**Why:** Stale `wt-*` branches accumulate over multiple sprint runs, polluting `git branch` output
and risking confusion with the sprint branch namespace. They also prevent `gitWorktreeAdd -b` from
succeeding on a relaunch if the prior worktree directory was removed but the branch was not
(git's `-b` flag fails if the branch already exists — which is intentional per the T6 design).
The prune step before add would NOT save this — prune only cleans `.git/worktrees/<name>` records
for missing directories, not orphaned branch refs.
