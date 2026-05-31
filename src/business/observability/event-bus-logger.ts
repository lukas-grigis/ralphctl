import type { EventBus } from '@src/business/observability/event-bus.ts';
import type { Logger, LogLevel, LogMeta } from '@src/business/observability/logger.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';

/**
 * Adapter that turns a `Logger` call into an `AppEvent.log` published on the shared `EventBus`.
 * The TUI status panels, the JSONL progress sink, and any future webhook subscriber consume those
 * same events — so writing through this logger automatically reaches every existing surface
 * without each use case needing to know what's listening.
 *
 * `scope` carries the dotted namespace from chained `named()` calls. It's emitted as
 * `meta.scope`, prepended to `message` (in square brackets) so sinks that render only the
 * message string still see where a record came from.
 */

export interface EventBusLoggerDeps {
  readonly eventBus: EventBus;
  readonly clock: () => IsoTimestamp;
}

export const createEventBusLogger = (deps: EventBusLoggerDeps): Logger => loggerForScope(deps, '');

const loggerForScope = (deps: EventBusLoggerDeps, scope: string): Logger => {
  const emit = (level: LogLevel, message: string, meta?: LogMeta): void => {
    const prefixed = scope.length > 0 ? `[${scope}] ${message}` : message;
    const fullMeta = scope.length > 0 ? { scope, ...(meta ?? {}) } : meta;
    deps.eventBus.publish({
      type: 'log',
      level,
      message: prefixed,
      ...(fullMeta !== undefined ? { meta: fullMeta } : {}),
      at: deps.clock(),
    });
  };

  return {
    debug: (message, meta) => emit('debug', message, meta),
    info: (message, meta) => emit('info', message, meta),
    warn: (message, meta) => emit('warn', message, meta),
    error: (message, meta) => emit('error', message, meta),
    named: (name) => loggerForScope(deps, scope.length > 0 ? `${scope}.${name}` : name),
  };
};
