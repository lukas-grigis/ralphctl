---
name: changelog-draft
description: Draft the ralphctl `CHANGELOG.md` `## [Unreleased]` section from the commits since the last release tag — grouping conventional-commit subjects into Keep-a-Changelog sections (Breaking / Added / Changed / Fixed / Removed) and flagging internal churn to omit. Use this whenever you're updating the changelog, preparing release notes, about to cut a release, or someone asks "what changed since the last version / tag". It produces a curated starting point, not a finished changelog — the changelog is user-facing prose, so the draft is meant to be rewritten for readers, not pasted raw.
when_to_use: Trigger on "update the changelog", "draft release notes", "what changed since last release/tag", "fill in Unreleased", or as the changelog step before a release. Pairs with the `release` skill (which promotes `[Unreleased]` to a dated section); run this first to populate it.
allowed-tools: Bash, Read, Edit
---

# Changelog Draft

`CHANGELOG.md` follows [Keep a Changelog](https://keepachangelog.com): a `## [Unreleased]` block at the top,
then dated `## [X.Y.Z] - YYYY-MM-DD` sections, each with `### Breaking / Added / Changed / Fixed / Removed`
subsections. Populating `[Unreleased]` by hand means re-reading every commit since the last tag and sorting
it by user impact — the kind of blank-page busywork that gets skipped or done sloppily right before a release.

This skill removes the blank page. A script groups the commits mechanically; you do the part that actually
matters — turning commit subjects (written for the next developer) into changelog lines (written for the user
reading release notes). Those are different audiences, and the gap between them is the whole job.

## When this earns its keep

- Updating `CHANGELOG.md`, or someone asks "what changed since the last version".
- Right before a release — run this to fill `[Unreleased]`, then hand off to the `release` skill which dates it.
- After a burst of merged work, to capture it while the context is fresh rather than reconstructing it later.

## How to run it

1. **Generate the grouped draft:**

   ```bash
   bash .claude/skills/changelog-draft/scripts/draft-changelog.sh
   ```

   It defaults to commits in `<last-tag>..HEAD`. Pass an explicit range to override (e.g. `v0.11.0..HEAD`).
   It emits `### Breaking / Added / Changed / Fixed / Removed` from `feat`/`fix`/`perf`/`refactor`/`!`/`BREAKING
CHANGE`, plus an **Internal — usually omit** bucket (`chore`/`docs`/`test`/`ci`/`build`/`deps`) for you to
   scan and discard.

2. **Curate — this is the real work, do not skip it.** The script's output is raw commit subjects. For each:
   - **Rewrite for a user, not the author.** `fix(tui): root-cause heap-leak — eventbus listeners` becomes
     `Fixed a memory leak during long Implement runs.` The user does not know what an EventBus listener is.
   - **Merge related commits** into one line — five `feat(tui)` commits that built one view are one entry.
   - **Drop internal-only churn.** Refactors, test changes, doc edits, dep bumps rarely belong in a user
     changelog — unless one changed observable behaviour. The Internal bucket exists so you check, not so you
     paste it.
   - **Move mis-grouped lines.** The script groups by commit _type_; real impact sometimes differs (a `fix`
     that removed a flag belongs in Removed). The `Removed` placeholder reminds you to scan for these.

3. **Insert under `## [Unreleased]`.** Read the current `CHANGELOG.md` top, place the curated subsections
   under the `[Unreleased]` heading (create it if missing), preserving the existing section order. Leave the
   dating to the `release` skill — `[Unreleased]` stays undated until release.

## Quality bar

A good changelog entry tells a user what changed _for them_ and, when relevant, what to do about it. If a
line would mean nothing to someone who has never seen the code, either rewrite it or cut it. Terseness is
fine; jargon and commit-hash-speak are not. When in doubt about whether something is user-visible, it
probably is not — the Internal bucket is larger than the user-facing one for a reason.

## Relationship to `release`

`changelog-draft` populates `[Unreleased]`; `release` promotes `[Unreleased]` to a dated `## [X.Y.Z]` section
and cuts the release. Run this one first.
