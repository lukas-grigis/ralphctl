// Retention audit: BOUNDED — `useSinkStream` keeps a trailing window of `T` refs sourced from the
// upstream `BusSink` (default 100, capped via `.slice(-limit)` once per flush/overflow inside the
// coalescer, and the initial replay is also `.slice(-limit)`). Memory footprint is `limit` ×
// ref-to-T; the sink itself owns the master buffer so the component-side window is incremental,
// not duplicative. The window now coalesces — many emits between flushes yield ONE React commit,
// not one-per-emit, which is what removed the commit-storm OOM.

/**
 * Hook that subscribes to a {@link BusSink} and re-renders on new values. The store-style API
 * keeps the most recent N entries in component state so a panel can show a live tail without
 * the parent retriggering a full snapshot read on every emit.
 *
 * Subscription is routed through {@link useCoalescedBuffer}: arrival rate is decoupled from
 * React-commit rate, so a high-frequency sink (e.g. a DEBUG-floor stream-json fan-out) cannot
 * drive one Yoga layout + Output allocation per emitted line.
 */

import { useCoalescedBuffer } from '@src/application/ui/tui/runtime/use-coalesced-buffer.ts';
import type { BusSink } from '@src/application/ui/tui/runtime/sinks-bus.ts';

export interface UseSinkStreamOptions {
  /** Cap on entries kept in component state. Default `100`. */
  readonly limit?: number;
  /**
   * If true, the hook seeds component state with the bus's existing buffer on mount. Default
   * `true` — every panel that mounts mid-run gets the recent history immediately.
   */
  readonly replay?: boolean;
  /** Flush cadence in ms. Test-only escape hatch; production callers use the default. */
  readonly flushMs?: number;
}

/** Subscribe to a bus and keep the trailing window in component state. */
export const useSinkStream = <T>(bus: BusSink<T>, opts: UseSinkStreamOptions = {}): readonly T[] => {
  const limit = opts.limit ?? 100;
  const replay = opts.replay !== false;

  return useCoalescedBuffer<T>({
    limit,
    ...(opts.flushMs !== undefined ? { flushMs: opts.flushMs } : {}),
    ...(replay ? { initial: bus.entries.slice(-limit) } : {}),
    subscribe: (push) => bus.subscribe(push),
    deps: [bus, limit, replay],
  });
};
