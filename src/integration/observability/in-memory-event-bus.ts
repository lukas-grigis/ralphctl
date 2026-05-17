import type { AppEvent } from '@src/business/observability/events.ts';
import type { EventBus } from '@src/business/observability/event-bus.ts';

/**
 * Default {@link EventBus} adapter. Synchronous fan-out, no buffering, no
 * replay — each subscriber sees only events published after it attached.
 *
 * A thrown handler is logged via `console.warn` so it does not stall
 * delivery to the remaining subscribers (mirrors the chain runner's
 * listener-isolation policy).
 */
export const createInMemoryEventBus = (): EventBus => {
  const handlers = new Set<(event: AppEvent) => void>();
  return {
    publish(event: AppEvent): void {
      for (const handler of [...handlers]) {
        try {
          handler(event);
        } catch (err) {
          console.warn('[event-bus] handler threw:', err);
        }
      }
    },
    subscribe(handler: (event: AppEvent) => void): () => void {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
  };
};
