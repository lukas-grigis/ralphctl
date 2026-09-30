---
name: rolling-window-vs-append-sink
description: A rolling-window buffer feeding an append-style sink duplicates events; one-flush-per-test misses it
metadata:
  type: feedback
---

A rolling-window buffer (`CoalescedBuffer` hands `onFlush` the whole trailing window) is built for replace-semantics
consumers like React `setItems`. Fed to an append-style sink (log bus `emit` per item), every flush re-emits the old
window, and a critical flush that clears the sink but not the window resurrects old entries on the next tick.

**Why it ships:** tests that advance the clock once per test never see a second flush.

**How to apply:** for any buffer/sink pair, decide replace vs append semantics explicitly per consumer, and require a
test that crosses at least two flush intervals with new events in between.
