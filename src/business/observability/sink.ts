/**
 * Generic output port. A `Sink<T>` is "an object you push values into" — fire-and-forget,
 * no return value. Concrete sinks live in `integration/`: in-memory buffers, broadcast
 * fan-outs, console writers, file appenders, etc.
 *
 * Use cases and adapters declare narrow sink ports (`LogSink`, …) as type aliases over
 * `Sink<T>` so the producer side stays decoupled from how the consumer processes the values.
 * The harness-signal channel no longer uses a `Sink` — every AI-spawning leaf publishes through
 * the plain `PublishSignal` function (`application/flows/_shared/publish-signal.ts`) instead.
 */
export interface Sink<T> {
  emit(value: T): void;
}
