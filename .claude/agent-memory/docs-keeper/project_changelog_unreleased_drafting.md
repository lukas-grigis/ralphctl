---
name: project_changelog_unreleased_drafting
description: Pointer: drafting [Unreleased] needs both origin/main since the last tag and the branch's own commits
metadata:
  type: project
---

Use the `changelog-draft` skill. Its blind spot: a PR squash-merged straight to `origin/main` can ship with no
`[Unreleased]` line, and local history never shows commits that landed from another worktree. Reconcile both
`git log <last-tag>..origin/main --first-parent --oneline` and `git log origin/main..HEAD --oneline` against the
existing prose before adding bullets.
