/**
 * `FakeLoggerPort` — non-IO fake of {@link LoggerPort} for use case unit
 * tests. Collects every log call into a flat in-memory list so tests can
 * assert on log behaviour where it matters.
 *
 * `child()` returns a new `FakeLoggerPort` that shares the parent's
 * `entries` array so emissions from any descendant are visible from the
 * root — tests assert on the root logger and don't have to chase children.
 */
import type { LogContext, LogLevel, LoggerPort } from '../ports/logger-port.ts';

export interface CapturedLog {
  readonly level: LogLevel;
  readonly message: string;
  readonly context: LogContext;
}

export class FakeLoggerPort implements LoggerPort {
  readonly entries: CapturedLog[];

  constructor(
    private readonly bound: LogContext = {},
    sharedEntries?: CapturedLog[]
  ) {
    this.entries = sharedEntries ?? [];
  }

  log(level: LogLevel, message: string, context?: LogContext): void {
    this.entries.push({
      level,
      message,
      context: { ...this.bound, ...(context ?? {}) },
    });
  }

  debug(message: string, context?: LogContext): void {
    this.log('debug', message, context);
  }

  info(message: string, context?: LogContext): void {
    this.log('info', message, context);
  }

  warn(message: string, context?: LogContext): void {
    this.log('warn', message, context);
  }

  error(message: string, context?: LogContext): void {
    this.log('error', message, context);
  }

  child(bound: LogContext): LoggerPort {
    return new FakeLoggerPort({ ...this.bound, ...bound }, this.entries);
  }

  time(): () => void {
    return () => {
      /* no-op */
    };
  }

  hasMessage(level: LogLevel, substring: string): boolean {
    return this.entries.some((e) => e.level === level && e.message.includes(substring));
  }
}
