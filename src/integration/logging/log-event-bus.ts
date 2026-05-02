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
 *
 * Replay buffer: the bus keeps the last N emitted events and replays them
 * to every new subscriber synchronously on `subscribe()`. Why: views
 * subscribe in `useEffect`, which runs AFTER first paint — but the chain
 * runner often emits its first warning (e.g. dirty-tree-preflight)
 * within microseconds of the chain launching, before the view's effect
 * has run. Without replay, those early events are silently dropped and
 * the user sees a "Recent events" section that's mysteriously empty.
 */
import type { LogContext, LogLevel } from '@src/business/ports/logger-port.ts';
import type { IsoTimestamp } from '@src/domain/values/iso-timestamp.ts';

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

const DEFAULT_REPLAY_SIZE = 50;

export class InMemoryLogEventBus implements LogEventBus {
  private readonly listeners = new Set<(event: LogEvent) => void>();
  private readonly replay: LogEvent[] = [];
  private readonly replaySize: number;
  private disposed = false;

  constructor(replaySize: number = DEFAULT_REPLAY_SIZE) {
    this.replaySize = Math.max(0, replaySize);
  }

  emit(event: LogEvent): void {
    if (this.disposed) return;
    if (this.replaySize > 0) {
      this.replay.push(event);
      if (this.replay.length > this.replaySize) {
        this.replay.splice(0, this.replay.length - this.replaySize);
      }
    }
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
    // Synchronous replay so a late subscriber sees the events that fired
    // between chain launch and view-effect-mount.
    for (const event of this.replay) {
      try {
        listener(event);
      } catch (err) {
        console.warn('LogEventBus listener threw on replay:', err);
      }
    }
    return () => {
      this.listeners.delete(listener);
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.listeners.clear();
    this.replay.length = 0;
  }
}
