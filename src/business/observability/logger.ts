/**
 * Structured log port. `debug` — intermediate decisions (off by default); `info` — outcomes worth
 * surfacing once; `warn` — recoverable / expected failures; `error` — failures the caller cannot
 * recover from in place. Messages stay short; structured detail goes in `meta` so each sink can
 * render it without parsing the message.
 */

export type LogMeta = Readonly<Record<string, unknown>>;

export interface Logger {
  debug(message: string, meta?: LogMeta): void;
  info(message: string, meta?: LogMeta): void;
  warn(message: string, meta?: LogMeta): void;
  error(message: string, meta?: LogMeta): void;
  /** Child logger scoped `name`; scopes compose with `.` (`named('a').named('b')` → `a.b`). */
  named(name: string): Logger;
}
