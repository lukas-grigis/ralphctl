// Retention audit: BOUNDED — `useEventBusBuffer` keeps a rolling window of `AppEvent` object refs
// (default 100, capped via `.slice(-limit)` once per flush/overflow inside the coalescer). Memory
// footprint scales with `limit` not session lifetime — each entry is a single ref to an
// already-allocated AppEvent (the bus does not deep-clone). The window now coalesces, so a burst
// of matching events yields ONE React commit rather than one-per-publish.

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

import { useRef } from 'react';
import type { AppEvent } from '@src/business/observability/events.ts';
import type { EventBus } from '@src/business/observability/event-bus.ts';
import { useCoalescedBuffer } from '@src/application/ui/tui/runtime/use-coalesced-buffer.ts';

export interface UseEventBufferOptions<T extends AppEvent> {
  readonly filter: (event: AppEvent) => event is T;
  /** Cap on events kept in component state. Default `100`. */
  readonly limit?: number;
  /** Flush cadence in ms. Test-only escape hatch; production callers use the default. */
  readonly flushMs?: number;
}

/**
 * Maintain a rolling buffer of events matching `filter`. Re-renders on matching publishes (at
 * most once per flush window); drops the oldest entries past `limit` so memory stays bounded for
 * long-running sessions.
 *
 * The filter is captured via a ref so callers can pass a fresh arrow function each render
 * without churning the bus subscription (which would drop already-buffered events). Only events
 * that pass `filterRef.current` are pushed into the coalescer.
 */
export const useEventBusBuffer = <T extends AppEvent>(bus: EventBus, opts: UseEventBufferOptions<T>): readonly T[] => {
  const limit = opts.limit ?? 100;
  const filterRef = useRef(opts.filter);
  filterRef.current = opts.filter;

  return useCoalescedBuffer<T>({
    limit,
    ...(opts.flushMs !== undefined ? { flushMs: opts.flushMs } : {}),
    subscribe: (push) =>
      bus.subscribe((event) => {
        if (filterRef.current(event)) push(event);
      }),
    deps: [bus, limit],
  });
};
