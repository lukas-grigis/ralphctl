/**
 * `JsonLogger` — non-TTY / piped / CI logger sink.
 *
 * Writes one JSON object per line to stdout (errors+warns to stderr).
 * Each record carries `{ level, message, timestamp, ...context }`. Honors
 * `RALPHCTL_LOG_LEVEL` and silences info/warn under `VITEST=1` like the
 * plain-text sink.
 */
import type { LogContext, LoggerPort, LogLevel } from '../../business/ports/logger-port.ts';
import { IsoTimestamp } from '../../domain/values/iso-timestamp.ts';

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

export interface JsonLoggerOptions {
  readonly level?: LogLevel;
  readonly context?: LogContext;
  readonly stdout?: (line: string) => void;
  readonly stderr?: (line: string) => void;
  /** Override the timestamp source — primarily for deterministic tests. */
  readonly now?: () => IsoTimestamp;
}

export class JsonLogger implements LoggerPort {
  private readonly minRank: number;
  private readonly level: LogLevel;
  private readonly context: LogContext;
  private readonly stdout: (line: string) => void;
  private readonly stderr: (line: string) => void;
  private readonly now: () => IsoTimestamp;

  constructor(opts: JsonLoggerOptions = {}) {
    this.level = opts.level ?? envLevel();
    this.minRank = LEVEL_RANK[this.level];
    this.context = opts.context ?? {};
    this.stdout =
      opts.stdout ??
      ((line) => {
        process.stdout.write(`${line}\n`);
      });
    this.stderr =
      opts.stderr ??
      ((line) => {
        process.stderr.write(`${line}\n`);
      });
    this.now = opts.now ?? (() => IsoTimestamp.now());
  }

  log(level: LogLevel, message: string, context?: LogContext): void {
    if (LEVEL_RANK[level] < this.minRank) return;
    const merged = { ...this.context, ...(context ?? {}) };
    const record: Record<string, unknown> = {
      level,
      message,
      timestamp: this.now(),
      ...merged,
    };
    const line = JSON.stringify(record);
    if (level === 'error' || level === 'warn') {
      this.stderr(line);
    } else {
      this.stdout(line);
    }
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
    return new JsonLogger({
      level: this.level,
      context: { ...this.context, ...bound },
      stdout: this.stdout,
      stderr: this.stderr,
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
