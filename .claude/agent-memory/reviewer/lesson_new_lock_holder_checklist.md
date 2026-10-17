---
name: lesson-new-lock-holder-checklist
description: Checks when a diff makes a new flow or action take an existing advisory lock key or adds a new lock file
metadata:
  type: feedback
---

When a diff makes another flow/action hold the sprint-dir lock (`repoLockFile(locksRoot, sprintDir)`) or adds a
lock file under `locksRoot`, check these. Each one has hidden readers.

- Other readers of the key: `integration/io/sprint-lock-reader.ts` (live-run detection for the Home "interrupted"
  list) and `io/lock-guard.ts` `anyLockHeld` (migration, project removal and housekeeping refuse while ANY `*.lock`
  is fresh). A short holder is harmless; a holder that waits on a user prompt is not.
- What runs under the lock: an interactive prompt or AI step inside the wrapped chain holds the lock for as long as the
  user takes. Contenders give up after ~5s (100 x 50ms) with "another ralphctl is running <purpose>".
- Optional locker deps (`fileLocker?` / `locksRoot?` on a repository) silently degrade to unlocked when omitted.
  Grep every `createFs*Repository(` site in `src/` (wire.ts, demo/seed, demo/scripted-run) and confirm wire.ts passes them.
- A new lock file only serialises its own holders. `update()` on `sprint-<id>.lock` does not exclude blind
  `sprintRepo.save()` callers (unblock, rename, status transitions), so the lost-update window shrinks to ms, not zero.
- Docs and comments that quote a docblock verbatim (e.g. tasks-panel-host's "MUST NOT run while...") go stale when
  the docblock is reworded; grep the quoted phrase.

**Why:** the gate (typecheck, lint, tests) cannot see any of these.
**How to apply:** run the greps above before calling a lock change complete.
