/**
 * Ink logger sink — publishes structured log events onto `logEventBus`.
 *
 * The Ink app subscribes to the bus via `useLoggerEvents()` and renders a
 * rolling log tail. Outside of Ink mounts, the bus simply has no subscribers
 * and the events are dropped cheaply.
 *
 * Unlike PlainTextSink, this sink never writes to stdout directly — that
 * would corrupt Ink's rendered frame. Writing to stdout only happens via
 * Ink's own render cycle.
 */

import type { LogContext, LoggerPort, SpinnerHandle } from '@src/business/ports/logger.ts';
import { logEventBus, type LogEvent } from '@src/integration/ui/tui/runtime/event-bus.ts';

let spinnerId = 0;

export class InkSink implements LoggerPort {
  constructor(private readonly context: LogContext = {}) {}

  private emit(event: LogEvent): void {
    logEventBus.emit(event);
  }

  // -- Structured log levels --------------------------------------------------

  debug(message: string, context?: LogContext): void {
    this.emit({ kind: 'log', level: 'debug', message, context: this.merge(context), timestamp: new Date() });
  }

  info(message: string, context?: LogContext): void {
    this.emit({ kind: 'log', level: 'info', message, context: this.merge(context), timestamp: new Date() });
  }

  warn(message: string, context?: LogContext): void {
    this.emit({ kind: 'log', level: 'warn', message, context: this.merge(context), timestamp: new Date() });
  }

  error(message: string, context?: LogContext): void {
    this.emit({ kind: 'log', level: 'error', message, context: this.merge(context), timestamp: new Date() });
  }

  // -- UI-level output --------------------------------------------------------

  success(message: string): void {
    this.emit({ kind: 'log', level: 'success', message, context: this.context, timestamp: new Date() });
  }

  warning(message: string): void {
    this.emit({ kind: 'log', level: 'warning', message, context: this.context, timestamp: new Date() });
  }

  tip(message: string): void {
    this.emit({ kind: 'log', level: 'tip', message, context: this.context, timestamp: new Date() });
  }

  // -- Layout -----------------------------------------------------------------

  header(title: string, icon?: string): void {
    this.emit({ kind: 'header', title, icon, timestamp: new Date() });
  }

  separator(width = 40): void {
    this.emit({ kind: 'separator', width, timestamp: new Date() });
  }

  field(label: string, value: string, _width?: number): void {
    void _width;
    this.emit({ kind: 'field', label, value, timestamp: new Date() });
  }

  card(title: string, lines: string[]): void {
    this.emit({ kind: 'card', title, lines, timestamp: new Date() });
  }

  newline(): void {
    this.emit({ kind: 'newline', timestamp: new Date() });
  }

  dim(message: string): void {
    this.emit({ kind: 'log', level: 'dim', message, context: this.context, timestamp: new Date() });
  }

  item(message: string): void {
    this.emit({ kind: 'log', level: 'item', message, context: this.context, timestamp: new Date() });
  }

  // -- Interactive ------------------------------------------------------------

  spinner(message: string): SpinnerHandle {
    const id = ++spinnerId;
    this.emit({ kind: 'spinner-start', id, message, timestamp: new Date() });
    return {
      succeed: (msg: string) => {
        this.emit({ kind: 'spinner-succeed', id, message: msg, timestamp: new Date() });
      },
      fail: (msg: string) => {
        this.emit({ kind: 'spinner-fail', id, message: msg, timestamp: new Date() });
      },
      stop: () => {
        this.emit({ kind: 'spinner-stop', id, timestamp: new Date() });
      },
    };
  }

  // -- Scoped child -----------------------------------------------------------

  child(context: LogContext): LoggerPort {
    return new InkSink({ ...this.context, ...context });
  }

  // -- Timing -----------------------------------------------------------------

  time(label: string): () => void {
    const start = Date.now();
    return () => {
      const ms = Date.now() - start;
      this.debug(`${label}: ${String(ms)}ms`);
    };
  }

  // -- Internals --------------------------------------------------------------

  private merge(extra?: LogContext): LogContext {
    if (!extra) return this.context;
    return { ...this.context, ...extra };
  }
}
