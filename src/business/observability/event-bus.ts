import type { AppEvent } from '@src/business/observability/events.ts';

/**
 * Process-wide pub/sub for {@link AppEvent}. One bus per `wire()` call;
 * adapters and use cases publish, UI surfaces and observability adapters
 * subscribe.
 *
 * Delivery is fire-and-forget and synchronous within the `publish()` call:
 * subscribers run in registration order, and a thrown subscriber must not
 * stall delivery to the rest. Subscribers receive only events published
 * after they subscribed — there is no replay; consumers that need state
 * should reconstruct it from their own subscription stream.
 *
 * Returning an unsubscribe function (rather than exposing `subscribe` /
 * `unsubscribe` as separate methods) keeps the lifecycle pairing local
 * to the call site that owns the subscription.
 */
export interface EventBus {
  publish(event: AppEvent): void;
  subscribe(handler: (event: AppEvent) => void): () => void;
}
