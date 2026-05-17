import type { Sink } from '@src/business/observability/sink.ts';

/**
 * Fan-out helper: forward every emitted value to N target sinks. Ordering is preserved per
 * target — each target sees the values in the same order the producer emitted them.
 *
 * One target throwing must NOT stall delivery to the rest of the set. Thrown errors are
 * caught and surfaced via `console.warn`; this matches the chain runner's listener-fan-out
 * convention so a misbehaving subscriber can't take down the producer.
 */
export const broadcastSink = <T>(targets: ReadonlyArray<Sink<T>>): Sink<T> => ({
  emit(value: T): void {
    for (const target of targets) {
      try {
        target.emit(value);
      } catch (err) {
        console.warn('[broadcast-sink] target threw:', err);
      }
    }
  },
});
