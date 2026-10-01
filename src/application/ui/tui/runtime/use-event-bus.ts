// Retention audit: BOUNDED — `useEventBusBuffer` keeps a rolling window of `AppEvent` object refs (default 100,
// capped via `.slice(-limit)` once per flush/overflow inside the coalescer).

/** Hooks that subscribe React components to the application {@link EventBus}. */

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

/** Maintain a rolling buffer of events matching `filter`. */
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
