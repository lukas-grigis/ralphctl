/**
 * Plain-text logger sink — ANSI-colored stdout, no screen control, no raw-mode.
 *
 * Used for one-shot CLI commands that don't mount Ink (e.g. `sprint show`,
 * `config show`) and as the fallback when `mountInkApp` detects non-TTY.
 *
 * Spinners render as three plain lines — `• start`, `✓ success`, `✗ fail` —
 * since animated frames would collide with Ink when Ink is mounted and are
 * pointless in non-TTY contexts.
 */

import { colors } from '@src/integration/ui/theme/theme.ts';
import type { LogContext, LoggerPort, LogLevel, SpinnerHandle } from '@src/business/ports/logger.ts';

const INDENT = '  ';

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
} as const;

const ICONS = {
  success: '+',
  error: 'x',
  warning: '!',
  info: 'i',
  tip: '?',
  item: '-',
  spinner: '•',
} as const;

function resolveLogLevel(): LogLevel {
  if (process.env['VITEST']) return 'error';
  const env = process.env['RALPHCTL_LOG_LEVEL']?.toLowerCase();
  if (env && env in LOG_LEVELS) return env as LogLevel;
  return 'info';
}

export class PlainTextSink implements LoggerPort {
  private readonly context: LogContext;
  private readonly minLevel: number;

  constructor(context: LogContext = {}, level?: LogLevel) {
    this.context = context;
    this.minLevel = LOG_LEVELS[level ?? resolveLogLevel()];
  }

  // -- Structured log levels --------------------------------------------------

  debug(message: string, context?: LogContext): void {
    if (this.minLevel > LOG_LEVELS.debug) return;
    const merged = this.mergeContext(context);
    const ctx = Object.keys(merged).length > 0 ? ` ${colors.muted(JSON.stringify(merged))}` : '';
    console.debug(`${colors.muted(`[debug]`)} ${message}${ctx}`);
  }

  info(message: string, context?: LogContext): void {
    if (this.minLevel > LOG_LEVELS.info) return;
    const merged = this.mergeContext(context);
    const ctx =
      this.minLevel === LOG_LEVELS.debug && Object.keys(merged).length > 0
        ? ` ${colors.muted(JSON.stringify(merged))}`
        : '';
    console.info(`${colors.info(ICONS.info)} ${message}${ctx}`);
  }

  warn(message: string, context?: LogContext): void {
    if (this.minLevel > LOG_LEVELS.warn) return;
    const merged = this.mergeContext(context);
    const ctx =
      this.minLevel === LOG_LEVELS.debug && Object.keys(merged).length > 0
        ? ` ${colors.muted(JSON.stringify(merged))}`
        : '';
    console.warn(`${colors.warning(ICONS.warning)} ${message}${ctx}`);
  }

  error(message: string, context?: LogContext): void {
    const merged = this.mergeContext(context);
    const ctx =
      this.minLevel === LOG_LEVELS.debug && Object.keys(merged).length > 0
        ? ` ${colors.muted(JSON.stringify(merged))}`
        : '';
    console.error(`${colors.error(ICONS.error)} ${message}${ctx}`);
  }

  // -- UI-level output --------------------------------------------------------

  success(message: string): void {
    console.log(`${INDENT}${colors.success(ICONS.success)} ${message}`);
  }

  warning(message: string): void {
    console.log(`${INDENT}${colors.warning(ICONS.warning)} ${message}`);
  }

  tip(message: string): void {
    console.log(`${INDENT}${colors.info(ICONS.tip)} ${colors.muted(message)}`);
  }

  // -- Layout -----------------------------------------------------------------

  header(title: string, icon?: string): void {
    console.log();
    const prefix = icon ? `${icon} ` : '';
    console.log(`${INDENT}${prefix}${colors.highlight(title)}`);
    console.log(`${INDENT}${colors.muted('─'.repeat(title.length + (icon ? 2 : 0)))}`);
    console.log();
  }

  separator(width = 40): void {
    console.log(`${INDENT}${colors.muted('─'.repeat(width))}`);
  }

  field(label: string, value: string, width = 14): void {
    const padded = `${label}:`.padEnd(width);
    console.log(`${INDENT}${colors.muted(padded)} ${value}`);
  }

  card(title: string, lines: string[]): void {
    console.log(`${INDENT}${colors.highlight(title)}`);
    for (const line of lines) {
      console.log(`${INDENT}${INDENT}${line}`);
    }
  }

  newline(): void {
    console.log();
  }

  dim(message: string): void {
    console.log(`${INDENT}${colors.muted(message)}`);
  }

  item(message: string): void {
    console.log(`${INDENT}${INDENT}${colors.muted(ICONS.item)} ${message}`);
  }

  // -- Interactive ------------------------------------------------------------

  /**
   * No-animation spinner — just prints start / succeed / fail as plain lines.
   * Acceptable in scripts, CI, and non-Ink contexts. Inside Ink, the InkSink
   * takes over and renders a real animated component.
   */
  spinner(message: string): SpinnerHandle {
    // Print the start line only at info or higher to avoid noise in tests.
    if (this.minLevel <= LOG_LEVELS.info) {
      console.log(`${INDENT}${colors.info(ICONS.spinner)} ${message}`);
    }
    return {
      succeed: (msg: string) => {
        if (this.minLevel <= LOG_LEVELS.info) {
          console.log(`${INDENT}${colors.success(ICONS.success)} ${msg}`);
        }
      },
      fail: (msg: string) => {
        console.error(`${INDENT}${colors.error(ICONS.error)} ${msg}`);
      },
      stop: () => undefined,
    };
  }

  // -- Scoped child -----------------------------------------------------------

  child(context: LogContext): LoggerPort {
    return new PlainTextSink({ ...this.context, ...context }, this.levelFromNumber());
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

  private mergeContext(extra?: LogContext): LogContext {
    if (!extra) return this.context;
    return { ...this.context, ...extra };
  }

  private levelFromNumber(): LogLevel {
    const entries = Object.entries(LOG_LEVELS) as [LogLevel, number][];
    return entries.find(([, v]) => v === this.minLevel)?.[0] ?? 'info';
  }
}
