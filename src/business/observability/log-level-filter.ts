/**
 * Pure log-level filter shared between every place that needs to gate {@link LogEvent}s on a
 * user-chosen floor (currently the TUI's `EventBus -> logBus` forwarder; future JSONL sinks and
 * webhook subscribers can reuse it). Lives in business/ because it consumes the domain's
 * `LogLevel` and is layer-pure (zero IO, zero React).
 *
 * Ordering — most → least severe:
 *
 *     silent (∞) > error > warn > info > debug
 *
 * `silent` is a synthetic floor that filters everything; a {@link LogEvent}'s own `level` is
 * narrowed to `Exclude<LogLevel, 'silent'>` (see `events.ts`) so we never have to invent a
 * severity for the silent variant on the event side.
 */

import type { LogLevel } from '@src/domain/value/log-level.ts';

type EventLogLevel = Exclude<LogLevel, 'silent'>;

/**
 * Numeric severity for ordering — higher = more severe. `silent` sits above `error` so any
 * event level compared against it returns `false` (nothing passes a silent floor).
 */
const SEVERITY: Readonly<Record<LogLevel, number>> = {
  silent: 100,
  error: 40,
  warn: 30,
  info: 20,
  debug: 10,
};

/**
 * Returns true when an event at {@link eventLevel} should be emitted given a configured
 * {@link floor}. A `silent` floor filters everything; otherwise the event passes when its
 * severity is at or above the floor.
 */
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
