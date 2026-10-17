---
name: seams_migration_backup_and_dry_run
description: Migration backup symlink policy (never dereference, verbatim, realpath root, worktrees excluded) and why the dry-run loop-skip depends on it
metadata:
  type: project
---

The data-migration backup (`data-migration/backup.ts`) never follows symlinks and skips
`sprints/*/worktrees/`. Do not flip `dereference` back to `true` "for a complete backup".

**Why:** sprint worktrees hold user repo checkouts with pnpm `node_modules` links; following them
ballooned the copy and a workspace self-link cycled into ENAMETOOLONG/ELOOP on every retry, blocking
the migration forever. The dry-run now SKIPS a symlink-loop entry instead of flagging a problem — that
skip is only honest because the backup copies the loop as a link; with dereference on, apply would fail
on the very entry the dry-run promised to leave alone.

**How to apply:**

- Three `fs.cp` traps the code relies on: with `dereference: false` a symlinked SOURCE ROOT is copied
  as a link (so the root is `realpath`ed first); without `verbatimSymlinks: true` Node rewrites relative
  links to absolute paths pointing back into the LIVE tree; and the filter runs on the root too.
- Accepted trade-off: a user-symlinked family dir (e.g. `data/memory -> elsewhere`) is backed up as a
  link only. ralphctl never creates links in `data/`, so this was judged rarer than foreign links.
- Worktrees are safe to exclude only because the migration never writes inside them (a sprint-dir
  rename moves them intact). A rollback that replaces `data/` wholesale with the backup drops them —
  the failure screen's "move the backup back" copy doesn't say so yet.
- Target-name stat faults (a loop sitting at the `<id>--<slug>` name) stay PROBLEMS: that is a real
  collision over the entity's canonical name, not a non-entry.
- Unverified: renaming a legacy sprint dir that holds worktrees leaves git's back-pointer at the old
  path, and the defensive `git worktree prune` in worktree setup would then drop the record.
