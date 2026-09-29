---
name: restore-pop-and-stash-count
description: Stash presence booleans lose entries when two same-key entries exist; count them
metadata:
  type: feedback
---

Worktree teardown/restore once tracked quarantined stashes with a boolean; two same-key entries plus a pop of the newer
lost work. The fix counts entries matching the task key (`quarantinedAtStart: number`) and re-stashes when the current
count is lower. The commit gate must inspect only the LAST attempt the branch opened, not `.every()` over all attempts.

**How to apply:** for stash/quarantine logic demand a real-git test that seeds two same-key entries, pops the newer,
and asserts both survive.
