---
name: project_changelog_unreleased_drafting
description: CHANGELOG [Unreleased] drafting must check both origin/main since last tag AND the working branch — merged PRs can silently lack a changelog line
metadata:
  type: project
---

When drafting/updating `CHANGELOG.md`'s `## [Unreleased]` section, a PR that squash-merged
straight to `origin/main` can land with zero changelog line even though it's fully shipped and
user-facing — the merge commit message is not the changelog. Concretely: PR #244 (evaluator
five-floor rubric — Robustness floor, N/A dimension outcome, rationale-before-verdict ordering)
merged to main via commit `14dd9bd5` on 2026-07-02 and had no `[Unreleased]` entry until this pass
added one.

**Why:** nothing in the merge workflow forces a changelog edit; `git log <last-tag>..origin/main
--oneline --first-parent` is the only reliable way to catch these, since local branch history
alone won't show commits that landed on main via a different worktree/branch.

**How to apply:** every `[Unreleased]` drafting pass must run _both_ commands and reconcile:

1. `git log <last-release-tag>..origin/main --oneline --first-parent` — catches PRs merged
   directly to main since the last release that never got a changelog line.
2. `git log origin/main..HEAD --oneline` — the current working branch's own unmerged commits.
   Cross-check each commit's subject against the existing `[Unreleased]` prose before adding a new
   bullet — some commits are follow-on fixes to a feature that already has an entry (for example this
   branch's `fix(evaluator): exempt N/A dimensions from critique synthesis and outcome rendering`
   extends PR #244's N/A mechanism to cover critique synthesis and `outcome.md` rendering — it earned
   its own Fixed-section bullet distinct from #244's Added-section bullet, not a merge into one).

See [[project_high_drift_areas]] for the broader list of doc sections that drift fastest.
