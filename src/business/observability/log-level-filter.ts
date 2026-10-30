import type { EventLogLevel, LogLevel } from '@src/domain/value/log-level.ts';

/** Higher = more severe; `silent` sits above `error`, so nothing passes a silent floor. */
const SEVERITY: Readonly<Record<LogLevel, number>> = {
  silent: 100,
  error: 40,
  warn: 30,
  info: 20,
  debug: 10,
};

/** Whether an event at `eventLevel` passes the configured `floor`. */
export const passesLogLevel = (eventLevel: EventLogLevel, floor: LogLevel): boolean => {
  if (floor === 'silent') return false;
  return SEVERITY[eventLevel] >= SEVERITY[floor];
};

/**
 * Small mutable holder for the current log-level floor. The TUI forwarder reads via `get()` on
 * each event; the settings view writes via `set()` when the user changes log level so live
 * updates take effect without restarting the TUI.
 */
export interface LogLevelGate {
  readonly get: () => LogLevel;
  readonly set: (level: LogLevel) => void;
}

export const createLogLevelGate = (initial: LogLevel): LogLevelGate => {
  let current = initial;
  return {
    get: (): LogLevel => current,
    set: (level: LogLevel): void => {
      current = level;
    },
  };
};
