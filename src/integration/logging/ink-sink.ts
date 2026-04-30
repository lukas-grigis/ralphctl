/**
 * `InkSink` — logger sink active while the Ink TUI is mounted.
 *
 * Publishes to a {@link LogEventBus} instead of writing stdout — direct
 * stdout writes would corrupt Ink's rendered frames. The TUI subscribes
 * to the bus and renders a rolling log tail.
 *
 * Outside an Ink mount the bus simply has no subscribers and emissions
 * drop cheaply.
 */
import type { LogContext, LoggerPort, LogLevel } from '../../business/ports/logger-port.ts';
import { IsoTimestamp } from '../../domain/values/iso-timestamp.ts';
import type { LogEventBus } from './log-event-bus.ts';

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
} as const;

function envLevel(): LogLevel {
  if (process.env['VITEST']) return 'error';
  const raw = process.env['RALPHCTL_LOG_LEVEL']?.toLowerCase();
  if (raw && raw in LEVEL_RANK) return raw as LogLevel;
  return 'info';
}

export interface InkSinkOptions {
  readonly level?: LogLevel;
  readonly context?: LogContext;
  readonly now?: () => IsoTimestamp;
}

export class InkSink implements LoggerPort {
  private readonly minRank: number;
  private readonly level: LogLevel;
  private readonly context: LogContext;
  private readonly now: () => IsoTimestamp;

  constructor(
    private readonly bus: LogEventBus,
    opts: InkSinkOptions = {}
  ) {
    this.level = opts.level ?? envLevel();
    this.minRank = LEVEL_RANK[this.level];
    this.context = opts.context ?? {};
    this.now = opts.now ?? (() => IsoTimestamp.now());
  }

  log(level: LogLevel, message: string, context?: LogContext): void {
    if (LEVEL_RANK[level] < this.minRank) return;
    this.bus.emit({
      level,
      message,
      timestamp: this.now(),
      context: { ...this.context, ...(context ?? {}) },
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
    return new InkSink(this.bus, {
      level: this.level,
      context: { ...this.context, ...bound },
      now: this.now,
    });
  }

  time(label: string): () => void {
    const start = Date.now();
    return () => {
      this.debug(label, { ms: Date.now() - start });
    };
  }
}
