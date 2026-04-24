---
name: merge-pr
description: Land an open PR on this repo — wait for CI to finish, then merge with a merge commit using admin bypass. Use whenever the user says "merge this PR", "/merge-pr", "ship the PR", "land the PR", or asks to merge a specific PR number. Defaults to the PR opened from the current branch.
when_to_use: After a PR is opened and CI is running (or done) and the user wants it landed. Also used as the merge step inside the `release` skill. Skip when the PR isn't open yet — open it first.
allowed-tools: Bash
---

# Merge PR

Standard end-of-PR landing flow for `lukas-grigis/ralphctl`.

Repo + branch-protection facts that shape this flow (verified via `gh repo view` /
`gh api .../branches/main/protection`):

- Only **merge commits** allowed — squash and rebase are off. `gh pr merge --squash` would 422.
- `deleteBranchOnMerge: true` — branches auto-delete after merge. **Do not pass `--delete-branch`.**
- `main` requires 1 approving review. Solo maintainer can't self-approve, so admin bypass is the standard tool here.
  `enforce_admins` is `false`, so the bypass is honored by the API.

## Args

- `<pr-number>` (optional) — when omitted, derive from the current branch via `gh pr view --json number,...`.

## Flow

1. **Resolve the PR.** If no number given:

   ```bash
   gh pr view --json number,title,state,headRefName,baseRefName,mergeable
   ```

   Bail if `state != OPEN` or `baseRefName != main`. Show the user `title` + `headRefName` so they see what they're
   about to land.

2. **Watch CI.** Block until checks finish:

   ```bash
   gh pr checks <num> --watch --fail-fast
   ```

   On failure: surface the failing check name + URL. **Do not retry, do not merge.** Hand back to the user — they decide
   whether to push a fix or close the PR.

3. **Merge with admin bypass.**

   ```bash
   gh pr merge <num> --merge --admin
   ```

   `--admin` is the load-bearing flag — it tells the GitHub API to use the caller's admin permissions to merge through
   the required-review rule.

4. **Confirm.** Print the merge commit SHA:

   ```bash
   gh pr view <num> --json mergeCommit -q .mergeCommit.oid
   ```

5. **Clean up the trailing branch.** The remote branch is gone (`deleteBranchOnMerge: true` handled it), but the local copy and stale remote-tracking ref still linger. Switch back to `main` and delete them:

   ```bash
   BRANCH="$(gh pr view <num> --json headRefName -q .headRefName)"
   git checkout main
   git pull --ff-only origin main           # fast-forward to the new merge commit
   git fetch --prune                          # drop the stale `origin/<branch>` ref
   git branch -D "$BRANCH" 2>/dev/null || true   # ok if it was never checked out locally
   ```

   If the local checkout has unpushed work that _isn't_ on the merged PR (rare, but possible if the user kept committing after pushing), `git branch -d` would refuse — `-D` is intentional here because the canonical history is now on `main` via the merge commit. Surface a warning if the deleted branch had commits not reachable from `main`.

## Why these defaults

- **`--merge`, not `--squash` / `--rebase`** — repo policy. The existing `chore(release): X.Y.Z (#NN)` commit subjects
  on `main` are merge-commit subjects; preserving that shape keeps tags aligned with PR history.
- **`--admin`** — the required-review rule exists for safety on multi-contributor PRs but blocks solo workflows. Admin
  bypass is the explicit "I am the reviewer" escape hatch. Use it knowingly, not silently.
- **No `--auto`** — `--watch` then merge is faster than the auto-merge queue and surfaces CI failures synchronously.

## When NOT to use

- **Stacked / dependent PRs** that need a specific merge order — sequence those manually, one `merge-pr` per stack tip.
- **PRs targeting branches other than `main`** — admin bypass is configured for `main`'s protection rules; other
  branches may have different rules and silently failing reviews shouldn't be papered over.
- **PRs with unresolved review threads you actually care about** — `--admin` will merge through them. Address first;
  don't bury them under the merge commit.
