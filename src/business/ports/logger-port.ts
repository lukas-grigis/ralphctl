/**
 * `LoggerPort` — structured logging seam used everywhere business code
 * needs to emit progress, warnings, errors, or debug traces.
 *
 * Three sinks live behind this port:
 *  - `PlainTextSink` — TTY one-shot CLI; ANSI-colored, human-readable stdout.
 *  - `JsonLogger`    — non-TTY / piped / CI; one JSON object per line.
 *  - `InkSink`       — Ink-mounted dashboard; publishes to an event bus the
 *                       log-tail component subscribes to. Never writes
 *                       stdout directly (would corrupt frames).
 *
 * Business code goes through this port, never through `console.log`.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Free-form key/value bag merged into structured log records. */
export type LogContext = Record<string, unknown>;

export interface LoggerPort {
  /** Generic log entry — adapters dispatch on `level`. */
  log(level: LogLevel, message: string, context?: LogContext): void;

  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;

  /**
   * Returns a child logger that merges `bound` into every log call's
   * context. Children compose; calling `.child()` on a child stacks the
   * context bags.
   */
  child(bound: LogContext): LoggerPort;

  /**
   * Returns a stop-fn that, when called, logs the elapsed milliseconds at
   * `debug` level under `label`. Idiomatic usage:
   *
   * ```ts
   * const stop = logger.time('plan-tasks');
   * await runPlan();
   * stop(); // → debug log with `{ ms: 1234 }`
   * ```
   */
  time(label: string): () => void;
}
