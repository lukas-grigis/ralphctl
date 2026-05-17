/**
 * Generic output port. A `Sink<T>` is "an object you push values into" — fire-and-forget,
 * no return value. Concrete sinks live in `integration/`: in-memory buffers, broadcast
 * fan-outs, console writers, file appenders, etc.
 *
 * Use cases and adapters declare narrow sink ports (`HarnessSignalSink`, `LogSink`, …) as
 * type aliases over `Sink<T>` so the producer side stays decoupled from how the consumer
 * processes the values.
 */
export interface Sink<T> {
  emit(value: T): void;
}
