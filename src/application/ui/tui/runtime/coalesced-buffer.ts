/** Consumer-side coalescer — decouples event-arrival rate from downstream flush rate. */

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
   * When `true`, the window is emptied immediately after each `onFlush` so a flush delivers only the values admitted
   * since the previous flush (a true delta), not a rolling trailing window.
   */
  readonly clearOnFlush?: boolean;
}

/** @public */
export interface CoalescedBuffer<T> {
  /** Accumulate a value into the trailing window. Does not flush; the timer does. */
  push(value: T): void;
  /** Force an immediate flush of the current window (used for replay-seed + unmount). */
  flushNow(): void;
  /** Drop the held window WITHOUT calling `onFlush`, and clear the dirty flag. */
  discard(): void;
  /** Idempotent timer teardown. Safe to call more than once. */
  stop(): void;
}

/**
 * Build a trailing-window coalescer.
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
