/**
 * Severity ordering used by sinks to filter on a floor level. The order below is the canonical
 * least → most severe (the `'silent'` option is a synthetic floor, never set on a concrete
 * `LogEvent` — its `level` is narrowed to `Exclude<LogLevel, 'silent'>`).
 *
 * Lives in domain because the `Settings` entity persists a user-chosen `logLevel`. The
 * observability ports that consume log events live in `business/observability`.
 */
export type LogLevel = 'silent' | 'debug' | 'info' | 'warn' | 'error';
