import type { LogContext, LoggerPort, LogLevel, SpinnerHandle } from '@src/business/ports/logger.ts';

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
} as const;

function resolveLogLevel(): LogLevel {
  if (process.env['VITEST']) return 'error';
  const env = process.env['RALPHCTL_LOG_LEVEL']?.toLowerCase();
  if (env && env in LOG_LEVELS) return env as LogLevel;
  return 'info';
}

export class JsonLogger implements LoggerPort {
  private readonly context: LogContext;
  private readonly minLevel: number;

  constructor(context: LogContext = {}, level?: LogLevel) {
    this.context = context;
    this.minLevel = LOG_LEVELS[level ?? resolveLogLevel()];
  }

  // -- Structured log levels --------------------------------------------------

  debug(message: string, context?: LogContext): void {
    if (this.minLevel > LOG_LEVELS.debug) return;
    this.write('debug', message, context);
  }

  info(message: string, context?: LogContext): void {
    if (this.minLevel > LOG_LEVELS.info) return;
    this.write('info', message, context);
  }

  warn(message: string, context?: LogContext): void {
    if (this.minLevel > LOG_LEVELS.warn) return;
    this.write('warn', message, context);
  }

  error(message: string, context?: LogContext): void {
    this.write('error', message, context);
  }

  // -- UI-level output --------------------------------------------------------

  success(message: string): void {
    this.write('info', message, undefined, 'success');
  }

  warning(message: string): void {
    this.write('warn', message, undefined, 'warning');
  }

  tip(message: string): void {
    this.write('info', message, undefined, 'tip');
  }

  // -- Layout -----------------------------------------------------------------

  header(title: string, icon?: string): void {
    this.write('info', title, icon ? { icon } : undefined, 'header');
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  separator(_width?: number): void {
    this.write('info', '', undefined, 'separator');
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  field(label: string, value: string, _width?: number): void {
    this.write('info', value, { label }, 'field');
  }

  card(title: string, lines: string[]): void {
    this.write('info', title, { lines }, 'card');
  }

  newline(): void {
    this.write('info', '', undefined, 'newline');
  }

  dim(message: string): void {
    this.write('info', message, undefined, 'dim');
  }

  item(message: string): void {
    this.write('info', message, undefined, 'item');
  }

  // -- Interactive ------------------------------------------------------------

  spinner(message: string): SpinnerHandle {
    this.write('info', message, undefined, 'spinner-start');
    return {
      succeed: (msg: string) => {
        this.write('info', msg, undefined, 'spinner-succeed');
      },
      fail: (msg: string) => {
        this.write('error', msg, undefined, 'spinner-fail');
      },
      stop: () => {
        /* no-op for JSON output */
      },
    };
  }

  // -- Scoped child -----------------------------------------------------------

  child(context: LogContext): LoggerPort {
    return new JsonLogger({ ...this.context, ...context }, this.levelFromNumber());
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

  private write(level: LogLevel, message: string, extra?: LogContext, type?: string): void {
    const entry: Record<string, unknown> = {
      level,
      message,
      timestamp: new Date().toISOString(),
      ...this.context,
      ...extra,
    };
    if (type) entry['type'] = type;
    console.log(JSON.stringify(entry));
  }

  private levelFromNumber(): LogLevel {
    const entries = Object.entries(LOG_LEVELS) as [LogLevel, number][];
    return entries.find(([, v]) => v === this.minLevel)?.[0] ?? 'info';
  }
}
