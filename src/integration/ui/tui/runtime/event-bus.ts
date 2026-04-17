/**
 * Event bus for logger events bound for the Ink UI.
 *
 * The Ink-mounted app subscribes via `useLoggerEvents()` and renders a rolling
 * log tail. Outside of Ink (plain CLI commands), the bus is never subscribed
 * to and its emissions are harmlessly dropped.
 *
 * Kept separate from `SignalBus` (signals) because log events are semantically
 * different — they're free-form text lines, not typed domain signals.
 */

import type { LogContext } from '@src/business/ports/logger.ts';

export type LogEventLevel = 'debug' | 'info' | 'warn' | 'error' | 'success' | 'warning' | 'tip' | 'item' | 'dim';

export type LogEvent =
  | { kind: 'log'; level: LogEventLevel; message: string; context: LogContext; timestamp: Date }
  | { kind: 'header'; title: string; icon?: string; timestamp: Date }
  | { kind: 'separator'; width: number; timestamp: Date }
  | { kind: 'field'; label: string; value: string; timestamp: Date }
  | { kind: 'card'; title: string; lines: string[]; timestamp: Date }
  | { kind: 'newline'; timestamp: Date }
  | { kind: 'spinner-start'; id: number; message: string; timestamp: Date }
  | { kind: 'spinner-succeed'; id: number; message: string; timestamp: Date }
  | { kind: 'spinner-fail'; id: number; message: string; timestamp: Date }
  | { kind: 'spinner-stop'; id: number; timestamp: Date };

export type LogEventListener = (events: readonly LogEvent[]) => void;
export type Unsubscribe = () => void;

export interface LogEventBus {
  emit(event: LogEvent): void;
  subscribe(listener: LogEventListener): Unsubscribe;
  dispose(): void;
}

const FRAME_MS = 16;

/**
 * Singleton log event bus.
 *
 * InkSink and the Ink `useLoggerEvents()` hook both reference this single
 * instance. There is no ambiguity about whose events go where — only one
 * Ink app mounts per process.
 */
class SingletonLogEventBus implements LogEventBus {
  private readonly listeners = new Set<LogEventListener>();
  private readonly buffer: LogEvent[] = [];
  private flushTimer: NodeJS.Timeout | null = null;

  emit(event: LogEvent): void {
    this.buffer.push(event);
    this.scheduleFlush();
  }

  subscribe(listener: LogEventListener): Unsubscribe {
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

export const logEventBus: LogEventBus = new SingletonLogEventBus();

/** Whether anyone is currently listening. Sinks may decide not to emit if nobody cares. */
export function hasLogEventSubscribers(): boolean {
  return (logEventBus as unknown as { listeners: Set<unknown> }).listeners.size > 0;
}
