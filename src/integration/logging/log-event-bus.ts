/**
 * `LogEventBus` — tiny pub/sub for log events.
 *
 * The `InkSink` publishes here and the Ink TUI subscribes (via a hook in
 * the UI layer that lives elsewhere). Outside of an Ink mount the bus has
 * no subscribers and emissions are dropped cheaply.
 *
 * Same shape as `SignalBusPort`: synchronous emit, listener errors do not
 * stall delivery, `dispose()` drops listeners. No micro-batching here —
 * log volume is low enough that per-event delivery is fine, and the TUI's
 * own render scheduler handles redraw coalescing.
 */
import type { LogContext, LogLevel } from '../../business/ports/logger-port.ts';
import type { IsoTimestamp } from '../../domain/values/iso-timestamp.ts';

export interface LogEvent {
  readonly level: LogLevel;
  readonly message: string;
  readonly timestamp: IsoTimestamp;
  readonly context: LogContext;
}

export interface LogEventBus {
  emit(event: LogEvent): void;
  subscribe(listener: (event: LogEvent) => void): () => void;
  dispose(): void;
}

export class InMemoryLogEventBus implements LogEventBus {
  private readonly listeners = new Set<(event: LogEvent) => void>();
  private disposed = false;

  emit(event: LogEvent): void {
    if (this.disposed) return;
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        // A broken subscriber must not stall the bus. The bus is pre-logger
        // infrastructure so we cannot route this through `LoggerPort`.
        console.warn('LogEventBus listener threw:', err);
      }
    }
  }

  subscribe(listener: (event: LogEvent) => void): () => void {
    if (this.disposed) return () => undefined;
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.listeners.clear();
  }
}
