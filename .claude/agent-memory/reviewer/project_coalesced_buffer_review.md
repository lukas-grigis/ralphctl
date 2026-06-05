---
name: project_coalesced_buffer_review
description: CoalescedBuffer onCritical window-not-cleared bug and double-seed nit from 0.10.0 commit-storm fix review
metadata:
  type: project
---

The CoalescedBuffer (0.10.0 OOM fix) review found two confirmed correctness bugs and one nit. **STATUS: all RESOLVED** in the amended OOM-fix commit (`fix(tui): coalesce bus→render updates`) — fix option 3 below was taken: added `clearOnFlush` (delta mode) + `discard()` to the primitive, the forwarder uses `clearOnFlush: true`, `onCritical` calls `discard()`, the session signature folds in pinned-sprint, and `useCoalescedBuffer` gained a `mountedRef` guard. Kept as a record of what the review caught and how the suite missed it (one-flush-per-test gap). Original findings below:

**HIGH - Multi-interval duplicate emission (CONFIRMED):** `CoalescedBuffer.window` is never cleared after a flush. `onFlush` receives the full trailing window (all events since creation, capped at `limit`). In the log-forwarder, `onFlush` loops `logBus.emit(event)` for each item — appending to `logBus.entries`. On flush tick 1 it emits [A,B,C]; on tick 2 it emits [A,B,C,D,E] — A/B/C are duplicated. This re-introduces memory pressure on long runs and causes log panel to show repeated entries. Root cause: `CoalescedBuffer` was designed for React's `setItems` (replace semantics) not for append-style sinks. The `onFlush` body in `createLogForwarder` (launch.ts:69) is appending, not replacing.

The test suite only advances the clock **once per test**, so two-interval scenarios with new events between ticks are never exercised.

**HIGH - onCritical window not cleared:** `flushNow()` in `onCritical` sets `dirty=false` but does NOT clear `window`. The next push after the critical sequence sets `dirty=true` and the next interval flush re-emits ALL old window contents — undoing the `clear()`. See above; these are the same root cause.

**NIT - double-seed in useCoalescedBuffer:** The `useState` lazy initializer seeds from `opts.initial` and the effect ALSO calls `setItems(seed.slice(-limit))` on mount. These produce different array references with the same values, triggering an extra render cycle on mount.

**Fix options for log-forwarder:**

1. Track a `forwarded` watermark cursor in the forwarder closure; in `onFlush` emit `window.slice(forwarded)` then set `forwarded = window.length`.
2. Use a local `pendingBatch: LogEvent[]` array; push admitted events into it; in `onFlush` emit the batch then splice it empty (delta semantics, does not use CoalescedBuffer's window at all).
3. Add a `clear()` or `discard()` to CoalescedBuffer that resets `window = []` and `dirty = false`, and call it in `onCritical` after `flushNow()`.
