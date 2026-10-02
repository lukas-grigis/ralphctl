---
name: memoized-clock-and-unmount-cleanup
description: Two React bug shapes lint/tests miss in TUI views — a re-render tick that never reaches a useMemo, and a cleanup that cancels a timer whose job was to publish a clear
metadata:
  type: feedback
---

1. A `useReducer` tick used "so elapsed times advance" does nothing when the time-derived rows are built inside a
   `useMemo` that captured `Date.now()` and does not list the tick in deps (`useWorkAgenda`: `const [, tick]`). The
   timer re-renders, the memo returns the cached rows, `[WAITING] waiting 2m` freezes. Check: does the tick value (or
   `now`) appear in the deps of every memo that formats time?
2. A hook that publishes `banner-show` and schedules a `banner-clear` timer (`useYankTask`) clears the timer on unmount
   without publishing the clear, so leaving the view inside the window strands the banner on the app-level bus. Cleanup
   must flush the pending clear, not just cancel it.

**Why:** both passed typecheck, lint and unit tests; neither is visible without advancing fake timers / unmounting
mid-window.

**How to apply:** for any `setInterval`/`setTimeout` in a view, trace what it mutates and whether the consumer is
memoized; for any timer whose callback has an externally visible side effect, require the cleanup to run it.
