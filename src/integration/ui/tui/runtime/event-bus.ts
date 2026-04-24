/**
 * Concrete `LogEventBus` adapter plus the process-wide default singleton.
 *
 * The interface + event shape lives in `src/business/ports/log-event-bus.ts`
 * so the execution registry port can expose per-execution buses without
 * integration types leaking into business.
 *
 * The Ink-mounted app subscribes via `useLoggerEvents()` and renders a rolling
 * log tail. Outside of Ink (plain CLI commands), the default singleton is never
 * subscribed to and its emissions are harmlessly dropped.
 */

import type {
  LogEvent,
  LogEventBus,
  LogEventLevel,
  LogEventListener,
  LogEventUnsubscribe,
} from '@src/business/ports/log-event-bus.ts';

// Re-export the shared types so existing call-sites can keep importing from
// this module; the canonical source of truth is the business port.
export type { LogEvent, LogEventBus, LogEventLevel, LogEventListener, LogEventUnsubscribe };

const FRAME_MS = 16;

/**
 * Micro-batching log event bus. Drains its buffer on an animation-frame tick
 * and fans the batch out to every listener. Used as the default singleton
 * and instantiated per-execution by `createExecutionScope` so concurrent
 * backgrounded executions do not cross-talk on the shared event stream.
 */
export class InMemoryLogEventBus implements LogEventBus {
  private readonly listeners = new Set<LogEventListener>();
  private readonly buffer: LogEvent[] = [];
  private flushTimer: NodeJS.Timeout | null = null;

  emit(event: LogEvent): void {
    this.buffer.push(event);
    this.scheduleFlush();
  }

  subscribe(listener: LogEventListener): LogEventUnsubscribe {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  dispose(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.listeners.clear();
    this.buffer.length = 0;
  }

  /** Force immediate drain. Primarily for tests. */
  flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.drain();
  }

  private scheduleFlush(): void {
    if (this.flushTimer !== null) return;
    const timer = setTimeout(() => {
      this.flushTimer = null;
      this.drain();
    }, FRAME_MS);
    timer.unref();
    this.flushTimer = timer;
  }

  private drain(): void {
    if (this.buffer.length === 0) return;
    const batch = this.buffer.splice(0, this.buffer.length);
    for (const listener of this.listeners) {
      try {
        listener(batch);
      } catch {
        // Swallow listener errors.
      }
    }
  }
}

export const logEventBus: LogEventBus = new InMemoryLogEventBus();
