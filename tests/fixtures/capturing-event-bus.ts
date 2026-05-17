import { createInMemoryEventBus } from '@src/integration/observability/in-memory-event-bus.ts';
import type { AppEvent, LogEvent } from '@src/business/observability/events.ts';
import type { EventBus } from '@src/business/observability/event-bus.ts';

export interface CapturingBus {
  readonly bus: EventBus;
  readonly events: readonly AppEvent[];
  /** Convenience: just the `'log'` events. Tests assert on `cap.logs[…]`. */
  readonly logs: readonly LogEvent[];
}

/**
 * Test helper: pair an in-memory `EventBus` with an auto-subscribed array of every event the
 * adapters publish.
 *
 * The arrays are mutable — `events`/`logs` accumulate as the bus publishes. Not safe to
 * snapshot mid-test if you need a stable point-in-time view; copy via `[...cap.logs]` first.
 */
export const createCapturingBus = (): CapturingBus => {
  const events: AppEvent[] = [];
  const logs: LogEvent[] = [];
  const bus = createInMemoryEventBus();
  bus.subscribe((event) => {
    events.push(event);
    if (event.type === 'log') logs.push(event);
  });
  return { bus, events, logs };
};
