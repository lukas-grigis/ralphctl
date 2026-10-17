---
name: checkout-free-branch-move
description: When a delegation says `git checkout -b <sha>` in a fresh clean worktree, ff-merge plus branch rename reaches the same state without the banned command
metadata:
  type: feedback
---

If the worktree is clean and its HEAD is an ancestor of the target commit, `git merge --ff-only <sha>` then
`git branch -m <new-name>` lands on the integration commit under the requested branch name. Check
`git merge-base --is-ancestor HEAD <sha>` first; if it is not an ancestor, stop and report instead of forcing it.

**Why:** the agent rules ban `checkout` / `switch` / `reset` because they destroyed shared uncommitted work, but
delegations written for generic agents still open with `git checkout -b`. The ff route moves nothing that was not
already committed.

**How to apply:** only for the first move onto the integration commit of a fresh worktree. Never use it on a tree
with uncommitted changes.
