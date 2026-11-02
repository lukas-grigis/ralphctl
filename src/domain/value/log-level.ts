/** The persisted log floor, least → most severe. In domain because `Settings` persists it. */
export type LogLevel = 'silent' | 'debug' | 'info' | 'warn' | 'error';

/** A concrete event's level — `silent` is a floor only, never an event's severity. */
export type EventLogLevel = Exclude<LogLevel, 'silent'>;
