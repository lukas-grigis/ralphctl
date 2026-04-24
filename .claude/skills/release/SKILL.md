---
name: release
description:
  Cut a new release of ralphctl — bumps `package.json`, promotes the `## [Unreleased]` CHANGELOG section to a dated `## [X.Y.Z]`, opens a `chore(release): X.Y.Z` PR, defers to `merge-pr` to wait for CI and merge with admin bypass, then tags the merge commit and pushes the tag (which fires the `release.yml` workflow → npm publish + GitHub Release). Use when the user says "/release X.Y.Z", "release X.Y.Z", "ship 1.2.3", "cut a new version", or otherwise asks to publish a new version of ralphctl.
when_to_use: When the user explicitly asks to ship a release. Requires the version arg in semver form (e.g. `0.4.5`, no `v` prefix). Pre-conditions checked at runtime — clean working tree on `main`, no other release branch in flight, `## [Unreleased]` has content worth releasing.
allowed-tools: Bash, Read, Edit
---

# Release

End-to-end release flow for `lukas-grigis/ralphctl`. Mirrors the established pattern (v0.4.2 / v0.4.3 / v0.4.4):
branch → bump → changelog → PR → CI → merge → tag → workflow.

## Arg

- `<version>` — semver, no `v` prefix (e.g. `0.4.5`, `1.0.0-rc.1`). Reject anything that doesn't match
  `^\d+\.\d+\.\d+(-[A-Za-z0-9.-]+)?$`.

## Pre-flight (stop on any failure — don't try to recover)

```bash
git rev-parse --abbrev-ref HEAD                   # must be `main`
[ -z "$(git status --porcelain)" ]                # working tree clean
git fetch origin && git pull --ff-only origin main
node -p "require('./package.json').version"       # must be < <version>
```

If any check fails, surface the exact problem and stop. Don't stash, don't switch branches, don't auto-fix — the user
wants to know.

### `## [Unreleased]` auto-draft

Check whether `## [Unreleased]` has content. Grab the body between that heading and the next `## [` heading:

```bash
awk '/^## \[Unreleased\]/{flag=1;next} /^## \[/{flag=0} flag' CHANGELOG.md | sed '/^$/d'
```

**If empty,** auto-draft entries from the commit range since the last tag, **skipping contributor-side tooling that
isn't shipped to npm** (`.claude/**`, `.github/**`, `CHANGELOG.md`, `CLAUDE.md`):

```bash
LAST_TAG="$(git describe --tags --abbrev=0)"
git log --no-merges --pretty='- %s' "${LAST_TAG}..HEAD" -- \
  ':!.claude' ':!.github' ':!CHANGELOG.md' ':!CLAUDE.md'
```

Group the surviving commit subjects by conventional-commit prefix into `### Added` (`feat:`), `### Fixed` (`fix:`),
`### Changed` (`refactor:` / `perf:` / user-facing `chore:`). Write the result under `## [Unreleased]` in
`CHANGELOG.md` (edit only — don't commit yet; the release commit in step 5 picks it up).

**If the filtered `git log` is also empty,** there's nothing user-facing to release — stop and tell the user. Don't
promote an empty section; `release.yml` would fall back to a raw `git log` dump and ship noise.

**If the original `## [Unreleased]` had content,** skip the draft — the user already wrote what they want. Proceed.

Surface the drafted entries back to the user before moving on so they can veto / rewrite in-place on the release
branch if anything looks off.

## Steps

1. **Branch.** `git checkout -b release/<version>`

2. **Bump `package.json`.** Edit the `"version"` field directly. **Do not** use `npm version` / `pnpm version` — those
   create a tag immediately, and we tag the _merge commit on `main`_, not the release-branch commit.

3. **Promote the changelog.** In `CHANGELOG.md`, replace exactly:

   ```
   ## [Unreleased]
   ```

   with:

   ```
   ## [Unreleased]

   ## [<version>] - <YYYY-MM-DD>
   ```

   Use today's UTC date in ISO format (`date -u +%Y-%m-%d`). Keep the existing entries where they are — they belong
   under the new dated heading by virtue of position. The heading format is **load-bearing**: `release.yml` extracts the
   GitHub Release body by `awk`-ing for `## [<version>]`, and a typo there silently falls back to a `git log` blob.

4. **Local gate.** Run the project's full check sequence (same as the `verify` skill):

   ```bash
   pnpm typecheck && pnpm lint && pnpm test
   ```

   All three must pass. If anything fails, stop — fix on a separate branch first; don't pile fixes onto a release
   branch.

5. **Commit + push.**

   ```bash
   git add package.json CHANGELOG.md
   git commit -m "chore(release): <version>"
   git push -u origin release/<version>
   ```

6. **Open the PR.**

   ```bash
   gh pr create --base main \
     --title "chore(release): <version>" \
     --body "$(cat <<'EOF'
   ## Summary

   - Bump version to <version>
   - Promote `## [Unreleased]` CHANGELOG section to `## [<version>]`

   ## Test plan

   - [x] `pnpm typecheck` · `pnpm lint` · `pnpm test` — green locally
   - [ ] CI green
   EOF
   )"
   ```

   Capture the PR number from the output URL.

7. **Defer to `merge-pr`.** Follow the `merge-pr` skill with the new PR number — it `--watch`es CI, runs
   `gh pr merge --merge --admin`, then **cleans up the trailing branch** (switches to `main`, fast-forwards, prunes the
   stale remote-tracking ref, deletes the local `release/<version>`). The merge commit lands on `main` with subject
   `chore(release): <version> (#NN)`. (See `.claude/skills/merge-pr/SKILL.md` for the why behind `--merge --admin`.)

8. **Tag the merge commit.** `merge-pr` already left us on `main` at the merge commit, so just tag and push:

   ```bash
   git tag v<version>                        # tags HEAD = the merge commit
   git push origin v<version>
   ```

9. **Watch the release workflow.** Tag push fires `.github/workflows/release.yml`:
   - re-runs format / lint / typecheck / test / build
   - verifies tag matches `package.json` version
   - publishes to npm with `--provenance`
   - creates a GitHub Release using the matching `## [<version>]` section as the body

   ```bash
   sleep 3   # let GH register the workflow run
   gh run watch --exit-status \
     "$(gh run list --workflow=release.yml --limit 1 --json databaseId -q '.[0].databaseId')"
   ```

10. **Done.** Print:
    - npm: `https://www.npmjs.com/package/ralphctl/v/<version>`
    - Release: `https://github.com/lukas-grigis/ralphctl/releases/tag/v<version>`

## Failure recovery

- **Local gate red:** Stop. Fix on a non-release branch. Restart `release` once `main` is green again.
- **CI red on the PR (step 7):** Don't merge. The branch is still a normal branch — push fixes, and `merge-pr`
  re-watches.
- **Workflow red after tag push (step 9):** The tag is already public. **Do not delete or move it** — npm provenance
  will refuse to re-publish the same version, and consumers may have already pulled. Cut the next patch version with the
  fix.
- **Cold feet before merge:** `gh pr close <num>` (auto-deletes the branch). No tag has been pushed yet. The version
  bump + changelog promotion exist only on the closed PR.

## Why this shape

- **Branch + PR (not direct push to `main`):** Branch protection requires a PR. Even with admin bypass, the audit trail
  and the PR's CI run are valuable — the workflow re-runs everything, but the PR catches issues before tagging (and tags
  are forever once published).
- **Tag the merge commit, not the release-branch tip:** The published artifact must match what's actually on `main`.
  Tagging the merge commit guarantees `git checkout v<version>` shows the same tree `main` had at release time.
- **One source of truth for release notes:** The workflow extracts `## [<version>] - <YYYY-MM-DD>` from `CHANGELOG.md`.
  Match the format exactly; otherwise the GitHub Release body silently falls back to a raw `git log` dump (still works,
  but noisy).
- **Admin bypass is loud, on purpose:** Each release surfaces the bypass via `--admin` rather than relying on auto-merge
  with weakened protections. The protections stay strict; the bypass is invoked explicitly.
