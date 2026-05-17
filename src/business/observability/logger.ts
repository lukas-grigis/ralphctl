/**
 * Structured log port. Use cases write through this; adapters (CLI, TUI, file sinks) read.
 *
 * Levels follow the standard four-tier shape:
 *   - debug — entering a use case, intermediate decisions; verbose, off by default.
 *   - info  — successful outcomes worth surfacing once (created X, transitioned Y).
 *   - warn  — recoverable / expected failures (validation rejected, conflict).
 *   - error — infrastructure failures the caller cannot recover from in-place.
 *
 * Messages are short past- or present-tense phrases (`'creating project'`, `'created project'`).
 * Structured detail goes in `meta` so subscribers can render the same information differently
 * (CLI line, TUI panel, JSONL file) without parsing the message.
 *
 * `named(name)` returns a child logger that prepends a dotted scope to every emitted record.
 * Use cases call `deps.logger.named('project.create')` once at entry so all subsequent records
 * carry that scope without repeating it on every call.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type LogMeta = Readonly<Record<string, unknown>>;

export interface Logger {
  debug(message: string, meta?: LogMeta): void;
  info(message: string, meta?: LogMeta): void;
  warn(message: string, meta?: LogMeta): void;
  error(message: string, meta?: LogMeta): void;
  /**
   * Return a child logger whose records carry `name` as a scope prefix. Names compose with `.`
   * separators, so `parent.named('a').named('b')` emits scope `a.b` (parent's own scope, if any,
   * is preserved as the outermost segment).
   */
  named(name: string): Logger;
}
