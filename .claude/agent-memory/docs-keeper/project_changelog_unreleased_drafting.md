---
name: project_changelog_unreleased_drafting
description: CHANGELOG [Unreleased] drafting must reconcile origin/main since the last tag AND the working branch — squash-merged PRs can land with no changelog line
metadata:
  type: project
---

Nothing in the merge workflow forces a changelog edit, and the merge commit message is not the
changelog. A PR that squash-merged straight to `origin/main` can be fully shipped and user-facing with
zero `[Unreleased]` line (e.g. PR #244, the evaluator five-floor rubric, merged 2026-07-02 and only got
an entry on a later pass). Local branch history alone never shows commits that landed on main from
another worktree or branch.

**How to apply:** every `[Unreleased]` drafting pass runs _both_ commands and reconciles them:

1. `git log <last-release-tag>..origin/main --oneline --first-parent` — PRs merged directly to main
   since the last release that never got a changelog line.
2. `git log origin/main..HEAD --oneline` — the current branch's own unmerged commits.

Cross-check each subject against the existing `[Unreleased]` prose before adding a bullet. A follow-on
fix that materially extends an already-listed feature earns its own bullet in the appropriate section
rather than being folded into the original entry.

See [[project_high_drift_areas]] for the broader list of doc sections that drift fastest.
