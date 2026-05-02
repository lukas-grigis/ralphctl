/**
 * `PlainTextSink` — TTY one-shot CLI logger sink.
 *
 * Writes ANSI-colored lines to stdout/stderr. Honours
 * `RALPHCTL_LOG_LEVEL` for level filtering and silences info/warn under
 * `VITEST=1` so test runs don't drown in noise.
 *
 * Context bound via `child()` is rendered after the message as
 * `key=value` pairs (debug-friendly without going full JSON).
 *
 * No screen control, no raw-mode — when Ink is mounted, `InkSink` is
 * used instead and this sink is bypassed entirely.
 */
import * as colorette from 'colorette';

import type { LogContext, LoggerPort, LogLevel } from '@src/business/ports/logger-port.ts';

// `success` ranks alongside `info` so milestone events flow with normal
// progress and are never suppressed at the default level.
const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  success: 1,
  warn: 2,
  error: 3,
} as const;

const PREFIX: Record<LogLevel, string> = {
  debug: colorette.gray('[debug]'),
  info: colorette.cyan('[info] '),
  // Sage-equivalent terminal green — keeps `[SUCCESS]` distinct from `[INFO]`
  // in the recent-events tail without going neon.
  success: colorette.green('[ok]   '),
  warn: colorette.yellow('[warn] '),
  error: colorette.red('[error]'),
} as const;

// Filter levels — `success` is intentionally excluded; it's not a valid
// configured log-level (treated as info-tier when filtering).
type FilterLevel = 'debug' | 'info' | 'warn' | 'error';
const FILTER_LEVELS: readonly FilterLevel[] = ['debug', 'info', 'warn', 'error'];

function envLevel(): LogLevel {
  if (process.env['VITEST']) return 'error';
  const raw = process.env['RALPHCTL_LOG_LEVEL']?.toLowerCase();
  if (raw && (FILTER_LEVELS as readonly string[]).includes(raw)) return raw as LogLevel;
  return 'info';
}

function renderContext(ctx: LogContext): string {
  const keys = Object.keys(ctx);
  if (keys.length === 0) return '';
  const parts = keys.map((k) => {
    const v = ctx[k];
    const repr =
      typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? String(v) : JSON.stringify(v);
    return `${k}=${repr}`;
  });
  return ` ${colorette.gray(parts.join(' '))}`;
}

export interface PlainTextSinkOptions {
  readonly level?: LogLevel;
  readonly context?: LogContext;
  /** Override the stdout/stderr writers (used by tests). */
  readonly stdout?: (line: string) => void;
  readonly stderr?: (line: string) => void;
}

export class PlainTextSink implements LoggerPort {
  private readonly minRank: number;
  private readonly level: LogLevel;
  private readonly context: LogContext;
  private readonly stdout: (line: string) => void;
  private readonly stderr: (line: string) => void;

  constructor(opts: PlainTextSinkOptions = {}) {
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
  }

  log(level: LogLevel, message: string, context?: LogContext): void {
    if (LEVEL_RANK[level] < this.minRank) return;
    const merged = this.merge(context);
    const line = `${PREFIX[level]} ${message}${renderContext(merged)}`;
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
    return new PlainTextSink({
      level: this.level,
      context: { ...this.context, ...bound },
      stdout: this.stdout,
      stderr: this.stderr,
    });
  }

  time(label: string): () => void {
    const start = Date.now();
    return () => {
      const ms = Date.now() - start;
      this.debug(label, { ms });
    };
  }

  private merge(extra?: LogContext): LogContext {
    if (!extra) return this.context;
    return { ...this.context, ...extra };
  }
}
