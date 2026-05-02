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
/**
 * Severity for log entries.
 *
 * `success` is a UX-only level — semantically it's an info-tier completion
 * milestone (task done, sprint complete, refine approved). Sinks render it
 * distinctly (green prefix / chip) so milestones stand out from routine
 * progress in the live execute view's "Recent events" panel. For the
 * level-filter purposes, `success` ranks the same as `info`: filtering at
 * `warn` or `error` suppresses both, and `info` (default) shows both.
 *
 * `success` is **not** a valid filter level — it does not appear in
 * `RALPHCTL_LOG_LEVEL` / `config.logLevel`. Those still take
 * `'debug' | 'info' | 'warn' | 'error'`.
 */
export type LogLevel = 'debug' | 'info' | 'success' | 'warn' | 'error';

/**
 * The subset of {@link LogLevel} values valid as a *filter threshold* —
 * `RALPHCTL_LOG_LEVEL` and `config.logLevel` accept only these. `success`
 * is not a filter level (see {@link LogLevel}'s docstring).
 */
export type LogFilterLevel = 'debug' | 'info' | 'warn' | 'error';

/** Free-form key/value bag merged into structured log records. */
export type LogContext = Record<string, unknown>;

export interface LoggerPort {
  /** Generic log entry — adapters dispatch on `level`. */
  log(level: LogLevel, message: string, context?: LogContext): void;

  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  /**
   * Emit a milestone (task completed, sprint executed, ticket approved).
   * Severity-equivalent to `info` for filtering — never suppressed at the
   * default level — but rendered with a distinct prefix and color so the
   * live UI surfaces completion events visibly.
   */
  success(message: string, context?: LogContext): void;
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
