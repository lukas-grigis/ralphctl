import type { Sink } from '@src/business/observability/sink.ts';

/**
 * Sink with an inspectable buffer. Test fixture — assert what was emitted by a flow or
 * provider. Generic over `T` so the same fixture works for `LogSink` and any future
 * `Sink<T>`-shaped port. The harness-signal channel no longer uses a `Sink` — every
 * AI-spawning leaf publishes through the plain `PublishSignal` function instead. If
 * production ever needs an inspectable buffer (e.g. a TUI panel rendering rolling history),
 * lift back into `src/integration/observability/sinks/`.
 */
export interface InMemorySink<T> extends Sink<T> {
  /** Snapshot of every value emitted so far, in emission order. Read-only view. */
  readonly entries: readonly T[];
  /** Drop every buffered entry. Idempotent. */
  clear(): void;
}

export const createInMemorySink = <T>(): InMemorySink<T> => {
  const buf: T[] = [];
  return {
    emit(value: T): void {
      buf.push(value);
    },
    get entries(): readonly T[] {
      return buf;
    },
    clear(): void {
      buf.length = 0;
    },
  };
};
