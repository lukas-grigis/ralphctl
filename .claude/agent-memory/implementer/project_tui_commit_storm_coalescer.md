---
name: tui-commit-storm-coalescer
description: consumer-side CoalescedBuffer decouples event-arrival rate from React-commit rate in the TUI runtime; the fix for the DEBUG-floor stream-json commit-storm OOM
metadata:
  type: project
---

The TUI OOM under a long DEBUG-floor run is a **React commit storm**, not a retained leak (every
buffer is already `.slice(-limit)` capped). Mechanism: per stream-json line → many `level:'debug'`
bus events → `useSinkStream` did `setItems(prev => [...prev, v])` per emit → one React commit per
line. Ink throttles stdout writes (~30fps) but NOT commits, so per-commit Yoga layout + Output
allocation ran unthrottled and V8 OOM'd mid-commit.

**Fix shape (all in `src/application/ui/tui/runtime/`, the outermost layer where React + node timers
are allowed):**

- `coalesced-buffer.ts` — pure factory `createCoalescedBuffer<T>({limit, flushMs?, onFlush, initial?, clearOnFlush?})`.
  Accumulates pushes; applies `slice(-limit)` ONCE per flush-or-overflow (not `[...prev,v]` spread per
  push — that O(n)/event spread WAS the heap-churn). One unref'd `setInterval`; `flushNow()`; `discard()`
  (empties window WITHOUT onFlush, resets dirty); idempotent `stop()`. `flushMs` default 60 (~16fps, under
  Ink's 30fps write throttle), floored at 16.
  - **Two flush modes** (the subtle part): default `clearOnFlush:false` = ROLLING-WINDOW REPLACE — window
    kept across flushes, `onFlush` gets the full trailing window each tick. CORRECT for `setItems`
    consumers (use-sink-stream/use-event-bus) since setItems replaces. But a forwarder whose onFlush
    RE-EMITS each value into a downstream sink MUST set `clearOnFlush:true` (DELTA mode: window emptied
    after each flush → each flush carries only new pushes). A rolling window + re-emit = re-emit prior
    batches every tick = re-grow the sink = the very OOM. This was bug 1 of the adversarial review.
- `use-coalesced-buffer.ts` — thin React hook; subscribe seam captured in a ref (fresh arrow each render
  must NOT churn the sub); deps array caller-owned; seeds initial + `flushNow()` on mount (mount-replay
  in one frame); cleanup `unsub(); buf.flushNow(); buf.stop()`.
- `use-sink-stream.ts` and `use-event-bus.ts` reimplemented on the hook — PUBLIC SIGNATURES UNCHANGED so
  views need no edits. Both gained an optional test-only `flushMs` hatch.
- `launch.ts` `createLogForwarder` helper: gate-at-ingest (`passesLogLevel` vs live gate) → push admitted
  → coalescer (`clearOnFlush:true`) `onFlush` re-emits the batch into `logBus` in one synchronous turn
  (downstream setStates batch into one commit). Heap-watchdog `onCritical` calls `forwarder.discard()`
  (NOT flushNow — flushing would re-emit the held window into logBus right before clearing it) THEN
  `harnessBus.clear(); logBus.clear();`. `forwarder.stop()` in `drain()`. (bug 2: flushNow-in-onCritical
  re-fed the bus; discard fixes it.)

**Why: ** EventBus/BusSink contract MUST stay synchronous fire-and-forget — coalescing is purely
consumer-side.

**How to apply: ** any future hot TUI subscription (high-frequency bus/sink fan-out) routes through
`useCoalescedBuffer` instead of per-event `setItems`. The gate at launch.ts's forwarder is the ONLY
UI-floor chokepoint — providers publish every stream-json line to the EventBus verbatim;
`createEventBusLogger` is a producer NOT a filter; events.ndjson sink writes verbatim regardless of floor.

**Second, log-floor-INDEPENDENT amplifier:** `session-manager.notify()` fires per leaf `step` into the
UNGUARDED `useSessions`/`useSession`, consumed by the always-mounted StatusBar. Guarded both with a
status-diff signature mirroring `views/sprint-detail-internals/use-sprint-bundle.ts` — only `setState`
when the signature changed; trace-only steps are swallowed. **Signature MUST include pinnedSprintId +
pinnedSprintLabel, not just `status|hasError`** (bug 3): `setPinnedSprint` (create-sprint, mid-run) changes
NO status, so a status-only signature drops the notify and the execute view shows a STALE undefined sprint.
Current sig: `${status}|${error?1:0}|${pinnedSprintId ?? ''}|${pinnedSprintLabel ?? ''}` via shared `sigOf()`.
Do NOT add `trace` to the signature — the live flow-steps rail stays current via the shared-mutable trace
array + sibling chainEvents re-render; adding trace re-introduces the per-step storm. See
[[project_per_attempt_round_display]] for the per-`step` notify cadence context.

**Bug 4 (use-coalesced-buffer mount re-seed):** the useState lazy initializer already holds
`initial.slice(-limit)`, so the effect's explicit `setItems(seed)` on FIRST mount is a redundant extra
commit. Gate it behind a `mountedRef` (false→true): skip the explicit re-seed on first effect run
(initializer covers it), still re-seed on a genuine deps-change re-run (state holds the prior deps' window).
Replay-paint-in-one-frame invariant preserved because the initializer guarantees it.

**Test conventions reinforced:** pure coalescer test uses `vi.useFakeTimers()` (no React in that layer,
matches heap-watchdog.test.ts). Rendered TUI hook tests MUST use REAL timers + drain-past-flushMs
(`flushMs:20`, drain ~60ms) — never `vi.useFakeTimers()` in ink-testing-library renders. Render-count
probe (`let renders; onRender=()=>renders++`) asserts ~1-2 commits for 50 emits, not 50.
