/**
 * Thin React hook over {@link createCoalescedBuffer}. Owns one buffer per mount and routes a
 * caller-supplied subscribe seam through it, so a hot source re-renders the consumer at most
 * once per `flushMs` instead of once per emitted value.
 *
 * The subscribe seam is captured in a ref so a caller passing a fresh arrow each render does NOT
 * churn the underlying subscription (which would drop already-buffered values) — same anti-churn
 * invariant the bus hooks rely on. The effect's dependency array stays caller-owned.
 *
 * Mount-replay: state is seeded from `initial` and a `flushNow()` runs on mount, so a panel that
 * mounts mid-run paints its history in a single frame rather than waiting for the first tick.
 */

import { useEffect, useRef, useState } from 'react';
import { type CoalescedBuffer, createCoalescedBuffer } from '@src/application/ui/tui/runtime/coalesced-buffer.ts';

export interface UseCoalescedBufferOptions<T> {
  /** Trailing-window cap. Default `100`. */
  readonly limit?: number;
  /** Flush cadence in ms. Test-only escape hatch; production callers use the default. */
  readonly flushMs?: number;
  /** Seed values for the initial window (mount-replay). */
  readonly initial?: readonly T[];
  /**
   * Attach the source to the buffer's `push`. Returns an unsubscribe. Captured in a ref so a
   * fresh arrow each render does not churn the subscription — the effect re-runs only on `deps`.
   */
  readonly subscribe: (push: (value: T) => void) => () => void;
  /**
   * Effect dependency list — owned by the caller so they decide what re-establishes the
   * subscription (e.g. `[bus, limit]`). The buffer is rebuilt whenever any of these change.
   */
  readonly deps: readonly unknown[];
}

/**
 * Maintain a coalesced trailing window in component state. Re-renders at most once per `flushMs`
 * while the source is hot; flushes immediately on mount (so seeded history paints) and on
 * cleanup (so no final batch is lost).
 */
export const useCoalescedBuffer = <T>(opts: UseCoalescedBufferOptions<T>): readonly T[] => {
  const limit = opts.limit ?? 100;
  const [items, setItems] = useState<readonly T[]>(() => (opts.initial ? opts.initial.slice(-limit) : []));

  // Capture the subscribe seam in a ref so a fresh arrow each render does not re-run the effect.
  const subscribeRef = useRef(opts.subscribe);
  subscribeRef.current = opts.subscribe;
  // Seed must be read from a ref too — only the explicit `deps` should rebuild the buffer.
  const initialRef = useRef(opts.initial);
  initialRef.current = opts.initial;
  // First effect run only: the useState lazy initializer already holds `initial.slice(-limit)`, so
  // an explicit re-seed there is a redundant extra commit on mount. A later deps-change re-run
  // still needs the re-seed (state holds the prior deps' window), so we gate on this flag.
  const mountedRef = useRef(false);

  useEffect(() => {
    const buf: CoalescedBuffer<T> = createCoalescedBuffer<T>({
      limit,
      ...(opts.flushMs !== undefined ? { flushMs: opts.flushMs } : {}),
      ...(initialRef.current !== undefined ? { initial: initialRef.current } : {}),
      onFlush: setItems,
    });
    // Replay: paint seeded history in one frame. Skipped on first mount (the initializer already
    // holds it); applied on deps-change re-runs so the rebuilt window repaints from the new seed.
    const seed = initialRef.current;
    if (mountedRef.current && seed && seed.length > 0) setItems(seed.slice(-limit));
    mountedRef.current = true;
    const unsub = subscribeRef.current(buf.push);
    return () => {
      unsub();
      buf.flushNow();
      buf.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are caller-owned by contract.
  }, [limit, opts.flushMs, ...opts.deps]);

  return items;
};
