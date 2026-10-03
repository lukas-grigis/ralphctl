---
name: concurrent-agent-writes
description: Parallel agents overwrite shared files (check git status mid-task); plus the zsh word-split trap that loses fixes in a backup-and-swap loop.
metadata:
  type: feedback
---

When multiple implementer agents run concurrently on the same branch (typical "parallel implementation" pattern), shared
files become hotspots. Symptoms seen:

- A "system-reminder: file modified by user or linter" notification often means another agent saved the file between my
  reads — not a linter.
- A `git status` snapshot can lie within a few seconds: a file shows modified, then another agent commits, then
  `git diff` shows nothing because the file's HEAD already matches.
- Edits to shared files (`flow.ts`, `ctx.ts`, `wire.ts`, `settle-attempt.ts`, schemas) can either be (a) silently
  absorbed into the other agent's commit (no diff in my final commit) or (b) revert-stomped if they save after me.

**Why:** parallel agents have no merge protocol — last-write-wins on disk; commits land in commit-time order.

**How to apply:**

1. Re-`git status` + `git log -3` before staging — a concurrent commit may have already absorbed (or partially undone)
   your edits.
2. After each shared-file edit, immediately verify the file content still reflects your intent (`grep` for the symbol
   you added). If it doesn't, the other agent overwrote — re-apply.
3. Don't rely on the conversation's "I edited X" memory; treat the on-disk file as authoritative.
4. Prefer adding NEW files over editing shared files when possible — collisions concentrate on the edited surfaces.
5. When the prompt specifies "another agent is touching X, your footprint is Y", be aggressive about staying inside Y.
   If you must touch shared files (because of cross-cutting refactors like new ctx fields), expect either absorption or
   stomping and verify post-hoc.
6. **Recovery from a full revert:** if a parallel agent's commit triggers a `reset: moving to HEAD` that nukes your
   unstaged work, the file content survives as **unreachable git blobs**. Find them with
   `git fsck --unreachable --no-reflogs | grep blob | awk '{print $3}' | while read h; do git cat-file -p "$h" | grep -l "<unique-symbol>" && echo "$h"; done`,
   then `git cat-file -p <hash> > <path>` to restore. Pre-commit hooks (lint-staged + reset) are the typical trigger.
7. **lint-staged backup stash + parallel commits is a triple-trap.** lint-staged auto-stashes unstaged changes during
   the pre-commit hook, runs hooks on staged-only state, then restores. If a parallel agent commits during that window,
   the restoration silently drops the conflicting changes — your in-flight unstaged edits to other files **vanish**.
   Symptom: `git status` shows your file clean against HEAD, but you have no recollection of committing it;
   `git log -p <file>` confirms your edits never landed. Mitigation: keep each commit's working-tree footprint small,
   stage incrementally, and `git status` immediately after every commit to detect a silent rollback. The lost edits ARE
   recoverable via `git fsck --unreachable` (same recipe as above).
8. **Full-tree stash + reset recovery (work lives IN the stash, not unreachable blobs).** A second variant of the
   trap: the harness (or a peer) ran `git stash` capturing the WHOLE in-flight tree (all agents' modified files) then
   `git reset --hard`/`reset: moving to HEAD`, leaving every owned file clean against HEAD — my edits AND the original
   feature code I was polishing both vanished. Detect via `git stash list` (a `WIP on <branch>` entry) +
   `git reflog -3` (a `reset: moving to HEAD`). Recover ONLY your owned files without disturbing peers' in-flight work:
   `git checkout stash@{0} -- <your files...>` (NOT `git stash pop`, which would touch every file in the stash and risk
   conflicts on surfaces you don't own). Confirm with `grep` for your symbols afterward. The stash is the canonical
   in-flight branch state here — peer additions (e.g. an unrelated `SIDEBAR_WIDTH` export riding along in a shared
   tokens file) are NOT yours to revert; leave them and verify the consumers still typecheck.

**zsh does not word-split `$VAR`.** `for f in $FILES` iterates ONCE over the whole string, so a
backup-then-swap loop (to see a test fail against HEAD sources) silently backs up nothing and the
restore loop no-ops — the fixes are lost. Use an array (`files=(a b); for f in $files`) and check
the backup exists before overwriting.
