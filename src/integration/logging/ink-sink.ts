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
import type { LogContext, LoggerPort, LogLevel } from '@src/business/ports/logger-port.ts';
import { IsoTimestamp } from '@src/domain/values/iso-timestamp.ts';
import { currentSessionId } from '@src/kernel/runtime/session-context.ts';
import type { LogEventBus } from './log-event-bus.ts';

// `success` ranks alongside `info` — milestone events flow with normal
// progress and are never suppressed at the default level.
const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  success: 1,
  warn: 2,
  error: 3,
} as const;

// Filter levels — `success` is intentionally excluded; it's not a valid
// configured log-level.
type FilterLevel = 'debug' | 'info' | 'warn' | 'error';
const FILTER_LEVELS: readonly FilterLevel[] = ['debug', 'info', 'warn', 'error'];

function envLevel(): LogLevel {
  if (process.env['VITEST']) return 'error';
  const raw = process.env['RALPHCTL_LOG_LEVEL']?.toLowerCase();
  if (raw && (FILTER_LEVELS as readonly string[]).includes(raw)) return raw as LogLevel;
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
    // Auto-tag with the active chain's session id when the log call was
    // made inside a `ChainRunner` scope. Outside any chain (one-shot
    // CLI / doctor / bootstrap rate-limit listener fired pre-chain), the
    // ALS reader returns undefined and the field is omitted — filtering
    // by sessionId in `useLoggerEvents` returns nothing for those
    // events, which is correct.
    const sid = currentSessionId();
    const merged: LogContext = { ...this.context, ...(context ?? {}) };
    // Caller-provided sessionId wins (callers explicitly tagging an
    // event for a different session is rare but legitimate).
    if (sid !== undefined && merged['sessionId'] === undefined) {
      merged['sessionId'] = sid;
    }
    this.bus.emit({
      level,
      message,
      timestamp: this.now(),
      context: merged,
    });
  }

  debug(message: string, context?: LogContext): void {
    this.log('debug', message, context);
  }
  info(message: string, context?: LogContext): void {
    this.log('info', message, context);
  }
  success(message: string, context?: LogContext): void {
    this.log('success', message, context);
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
