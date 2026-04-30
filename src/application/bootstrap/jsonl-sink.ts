/**
 * `JsonlSink` — `LoggerPort` adapter that pushes every log entry into a
 * {@link JsonlFileWriter}. Pairs with {@link FanOutLogger}: the
 * composition root constructs one console sink (Plain / Json / Ink) plus
 * one `JsonlSink`, fans them out, and the on-disk session log captures
 * everything.
 *
 * The writer is owned externally — `dispose()` lifecycle is managed by
 * the composition root, not this sink.
 */
import type { LogContext, LoggerPort, LogLevel } from '../../business/ports/logger-port.ts';
import { IsoTimestamp } from '../../domain/values/iso-timestamp.ts';
import type { JsonlFileWriter } from '../../integration/logging/jsonl-file-writer.ts';

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

export interface JsonlSinkOptions {
  readonly level?: LogLevel;
  readonly context?: LogContext;
  readonly now?: () => IsoTimestamp;
}

export class JsonlSink implements LoggerPort {
  private readonly minRank: number;
  private readonly level: LogLevel;
  private readonly context: LogContext;
  private readonly now: () => IsoTimestamp;

  constructor(
    private readonly writer: JsonlFileWriter,
    opts: JsonlSinkOptions = {}
  ) {
    this.level = opts.level ?? envLevel();
    this.minRank = LEVEL_RANK[this.level];
    this.context = opts.context ?? {};
    this.now = opts.now ?? (() => IsoTimestamp.now());
  }

  log(level: LogLevel, message: string, context?: LogContext): void {
    if (LEVEL_RANK[level] < this.minRank) return;
    // Fire-and-forget: the writer serialises internally. Errors land in
    // the returned `Result` we deliberately ignore — a failing log file
    // must not crash the harness.
    void this.writer.write({
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
    return new JsonlSink(this.writer, {
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
