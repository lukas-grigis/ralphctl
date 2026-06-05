/**
 * Consumer-side coalescer — decouples event-arrival rate from downstream flush rate.
 *
 * The EventBus / BusSink contract stays synchronous fire-and-forget; this buffer is the seam
 * that lets a hot subscription (a DEBUG-floor stream-json fan-out, or a per-`step` session
 * notify) push thousands of values per second while only delivering a trailing window to its
 * consumer at most once per `flushMs`. In the TUI that consumer is a `setItems`, so each flush
 * is one React commit instead of one-per-push — the fix for the commit-storm OOM.
 *
 * Pure + framework-agnostic: no React, no class, no `this`. Owns a single `setInterval`. The
 * `slice(-limit)` cap runs once per flush (or on overflow), never the `[...prev, v]` spread per
 * push that was the actual O(n)/event heap-churn source.
 */

/** Lower bound on the flush interval. Below this the coalescing buys nothing and just burns CPU. */
const MIN_FLUSH_MS = 16;
/** Default flush cadence — ≈16fps, comfortably under Ink's ~30fps stdout-write throttle. */
const DEFAULT_FLUSH_MS = 60;

/** @public */
export interface CoalescedBufferOptions<T> {
  /** Trailing-window cap. The window handed to `onFlush` never exceeds this length. */
  readonly limit: number;
  /** Flush cadence in ms. Default {@link DEFAULT_FLUSH_MS}; floored at {@link MIN_FLUSH_MS}. */
  readonly flushMs?: number;
  /** Invoked with a copy of the trailing window when (and only when) there are pending pushes. */
  readonly onFlush: (window: readonly T[]) => void;
  /** Seed values — trimmed to the trailing `limit` and used as the initial window. */
  readonly initial?: readonly T[];
  /**
   * When `true`, the window is emptied immediately after each `onFlush` so a flush delivers only
   * the values admitted since the previous flush (a true delta), not a rolling trailing window.
   * Default `false` (rolling-window REPLACE semantics, for `setItems` consumers).
   *
   * Used by forwarders whose `onFlush` re-emits each window value into a downstream sink: a
   * rolling window would re-emit prior-flush values every tick and re-grow the sink. `limit`
   * still caps a single pre-flush interval.
   */
  readonly clearOnFlush?: boolean;
}

/** @public */
export interface CoalescedBuffer<T> {
  /** Accumulate a value into the trailing window. Does not flush; the timer does. */
  push(value: T): void;
  /** Force an immediate flush of the current window (used for replay-seed + unmount). */
  flushNow(): void;
  /**
   * Drop the held window WITHOUT calling `onFlush`, and clear the dirty flag. Use to abandon a
   * pending batch (e.g. a forwarder on heap-critical that must not re-feed its downstream sink
   * right before that sink is cleared).
   */
  discard(): void;
  /** Idempotent timer teardown. Safe to call more than once. */
  stop(): void;
}

/**
 * Build a trailing-window coalescer. Accumulates pushes, applies the `limit` cap once per flush
 * or overflow, and delivers a copy of the window to `onFlush` at most once per `flushMs` — only
 * when there is something new to deliver.
 *
 * @public
 */
export const createCoalescedBuffer = <T>(opts: CoalescedBufferOptions<T>): CoalescedBuffer<T> => {
  const limit = opts.limit;
  const flushMs = Math.max(MIN_FLUSH_MS, opts.flushMs ?? DEFAULT_FLUSH_MS);
  const clearOnFlush = opts.clearOnFlush ?? false;

  let window: T[] = opts.initial ? opts.initial.slice(-limit) : [];
  let dirty = false;

  const flush = (): void => {
    if (!dirty) return;
    dirty = false;
    opts.onFlush(window.slice());
    // Delta consumers reset the window each flush so the next flush carries only new pushes;
    // resetting also keeps `window` from ever holding stale indices the overflow trim would shift.
    if (clearOnFlush) window = [];
  };

  // One unref'd interval so a pending flush never holds the event loop open on shutdown.
  const handle = setInterval(flush, flushMs);
  handle.unref?.();

  return {
    push(value: T): void {
      window.push(value);
      // Cap on overflow so a flood between flushes can't grow `window` past `limit` either.
      if (window.length > limit) window = window.slice(-limit);
      dirty = true;
    },
    flushNow(): void {
      flush();
    },
    discard(): void {
      window = [];
      dirty = false;
    },
    stop(): void {
      clearInterval(handle);
    },
  };
};
