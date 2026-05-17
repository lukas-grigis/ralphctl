import type { Sink } from '@src/business/observability/sink.ts';

/**
 * No-op sink. Drops every emitted value silently. Useful as a default when a feature is
 * disabled (`logging.level: 'silent'`), for tests that don't care about emitted values, or
 * as a placeholder before the concrete sink is wired up.
 */
export const nullSink = <T>(): Sink<T> => ({
  emit(): void {
    // discard
  },
});
