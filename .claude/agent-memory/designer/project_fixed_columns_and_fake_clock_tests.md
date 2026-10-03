---
name: project-fixed-columns-and-fake-clock-tests
description: Timeline time/kind columns need fixed-width non-shrinking Boxes; proving a fake-clock tick needs settle-then-jump-then-advance
metadata:
  type: project
---

Flex rows shrink plain sibling `<Text>`s and wrap them ("13:20:" / "00"), so every timeline column sits in `<Box width flexShrink={0}>`; only the message truncates.

**Why:** shows only at widths where the message overflows; the revamp fix was lost in the classic restore.
**How to apply:** any new fixed-column row (cursor, time, kind) follows `signal-rows.tsx`.

Proving a periodic tick (Home age labels) with fake timers: let async loads settle (many setImmediate spins), move the clock with `vi.setSystemTime` and assert the label is still stale, then `advanceTimersByTimeAsync` one tick period. `advanceTimers` also advances faked Date, so budget the total elapsed. Advancing 30s replays every spinner frame as a render (~4s), so give the test an explicit timeout.

**Why:** a render triggered by late loads recomputes the memo and refreshes the label, so "passes without the tick" unless settled first.
