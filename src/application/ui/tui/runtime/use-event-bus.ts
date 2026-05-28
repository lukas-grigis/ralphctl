// Retention audit: BOUNDED — `useEventBusBuffer` keeps a rolling window of `AppEvent` object refs
// (default 100, trimmed via `.slice(-limit)` on every push). Memory footprint scales with `limit`
// not session lifetime — each entry is a single ref to an already-allocated AppEvent (the bus does
// not deep-clone), so worst-case retention is `limit` × ~one event object. Sound because the FIFO
// trim runs synchronously inside the setState reducer; no path skips it.

/**
 * Hooks that subscribe React components to the application {@link EventBus}.
 *
 * The TUI keeps its existing `useSinkStream` for the buffered `BusSink`s
 * (harness signals, log entries with mount-replay) but new panels that
 * just want chain progress milestones, task verdicts, or feedback rounds
 * subscribe via `useEventBus*` here.
 *
 * No replay: AppEvents are not buffered by the bus itself. A panel that
 * mounts mid-run sees only events emitted after mount. The session
 * manager remains the source of truth for "what has already happened" on
 * a per-runner basis (descriptors carry the full trace at terminal).
 */

import { useEffect, useRef, useState } from 'react';
import type { AppEvent } from '@src/business/observability/events.ts';
import type { EventBus } from '@src/business/observability/event-bus.ts';

export interface UseEventBufferOptions<T extends AppEvent> {
  readonly filter: (event: AppEvent) => event is T;
  /** Cap on events kept in component state. Default `100`. */
  readonly limit?: number;
}

/**
 * Maintain a rolling buffer of events matching `filter`. Re-renders on each matching publish;
 * drops the oldest entries past `limit` so memory stays bounded for long-running sessions.
 *
 * The filter is captured via a ref so callers can pass a fresh arrow function each render
 * without churning the bus subscription (which would drop already-buffered events).
 */
export const useEventBusBuffer = <T extends AppEvent>(bus: EventBus, opts: UseEventBufferOptions<T>): readonly T[] => {
  const limit = opts.limit ?? 100;
  const [items, setItems] = useState<readonly T[]>([]);
  const filterRef = useRef(opts.filter);
  filterRef.current = opts.filter;

  useEffect(() => {
    return bus.subscribe((event) => {
      if (!filterRef.current(event)) return;
      setItems((prev) => {
        const next = [...prev, event];
        return next.length > limit ? next.slice(next.length - limit) : next;
      });
    });
  }, [bus, limit]);

  return items;
};
