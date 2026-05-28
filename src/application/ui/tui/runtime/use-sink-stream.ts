// Retention audit: BOUNDED — `useSinkStream` keeps a trailing window of `T` refs sourced from the
// upstream `BusSink` (default 100, trimmed via `.slice(-limit)` on push, and the initial replay is
// also `.slice(-limit)`). Memory footprint is `limit` × ref-to-T; the sink itself owns the master
// buffer so the component-side window is incremental, not duplicative. Sound because both the
// mount-time seed and the per-publish reducer apply the same `limit` ceiling.

/**
 * Hooks that subscribe to a {@link BusSink} and re-render on new values. The store-style API
 * keeps the most recent N entries in component state so a panel can show a live tail without
 * the parent retriggering a full snapshot read on every emit.
 */

import { useEffect, useState } from 'react';
import type { BusSink } from '@src/application/ui/tui/runtime/sinks-bus.ts';

export interface UseSinkStreamOptions {
  /** Cap on entries kept in component state. Default `100`. */
  readonly limit?: number;
  /**
   * If true, the hook seeds component state with the bus's existing buffer on mount. Default
   * `true` — every panel that mounts mid-run gets the recent history immediately.
   */
  readonly replay?: boolean;
}

/** Subscribe to a bus and keep the trailing window in component state. */
export const useSinkStream = <T>(bus: BusSink<T>, opts: UseSinkStreamOptions = {}): readonly T[] => {
  const limit = opts.limit ?? 100;
  const replay = opts.replay !== false;

  const [items, setItems] = useState<readonly T[]>(() => (replay ? bus.entries.slice(-limit) : []));

  useEffect(() => {
    if (replay) setItems(bus.entries.slice(-limit));
    return bus.subscribe((value) => {
      setItems((prev) => {
        const next = [...prev, value];
        return next.length > limit ? next.slice(next.length - limit) : next;
      });
    });
  }, [bus, limit, replay]);

  return items;
};
