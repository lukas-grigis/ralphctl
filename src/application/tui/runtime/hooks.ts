/**
 * React hooks bridging the non-React event buses (logEventBus,
 * SessionManagerPort) and the Ink component tree.
 */

import { useEffect, useState } from 'react';
import type { LogEvent } from '@src/integration/logging/log-event-bus.ts';
import type { SessionManagerPort, SessionDescriptor } from '@src/application/runtime/session-manager-port.ts';
import { logEventBus } from './event-bus.ts';

/**
 * Options for {@link useLoggerEvents}.
 *
 * - `max` — rolling buffer size (default 200).
 * - `sessionId` — when set, only events tagged with this session id are
 *   delivered. The `InkSink` auto-tags emissions made inside a chain
 *   runner's ALS scope (see `kernel/runtime/session-context.ts`), so
 *   filtering by `descriptor.id` shows only events from that chain.
 *   When `undefined`, the hook returns the unfiltered global stream
 *   (same behaviour as before).
 */
export interface UseLoggerEventsOptions {
  readonly max?: number;
  readonly sessionId?: string;
}

/**
 * Subscribe to log events. Returns a rolling buffer of the most recent
 * events up to `max` (default 200). The buffer is a new array on every
 * update so React re-renders correctly.
 *
 * Backwards-compatible: `useLoggerEvents()` and `useLoggerEvents(50)`
 * still return the full global stream. Pass an options object with a
 * `sessionId` to scope the buffer to a single chain run.
 */
export function useLoggerEvents(limitOrOpts?: number | UseLoggerEventsOptions): readonly LogEvent[] {
  const opts: UseLoggerEventsOptions = typeof limitOrOpts === 'number' ? { max: limitOrOpts } : (limitOrOpts ?? {});
  const limit = opts.max ?? 200;
  const sessionId = opts.sessionId;
  const [buffer, setBuffer] = useState<LogEvent[]>([]);

  useEffect(() => {
    setBuffer([]);
    const unsubscribe = logEventBus.subscribe((event) => {
      // Filter at the consumer when a session scope was requested. The
      // bus is a single global stream — tagging happens at the InkSink
      // boundary via `currentSessionId()` from the chain runner's ALS
      // scope, and we filter here so views only see their own session.
      if (sessionId !== undefined && event.context['sessionId'] !== sessionId) return;
      setBuffer((prev) => {
        const next = [...prev, event];
        if (next.length > limit) next.splice(0, next.length - limit);
        return next;
      });
    });
    return unsubscribe;
  }, [limit, sessionId]);

  return buffer;
}

/**
 * Subscribe to session lifecycle events via the SessionManager.
 * Returns a snapshot of all current sessions on every registry change.
 * Accepts `null` to no-op — safe to pass before deps are wired.
 */
export function useSessionEvents(sessionManager: SessionManagerPort | null): readonly SessionDescriptor[] {
  const [sessions, setSessions] = useState<readonly SessionDescriptor[]>(() =>
    sessionManager ? sessionManager.list() : []
  );

  useEffect(() => {
    if (sessionManager === null) {
      setSessions([]);
      return;
    }
    setSessions(sessionManager.list());
    const unsubscribe = sessionManager.subscribe(() => {
      setSessions(sessionManager.list());
    });
    return unsubscribe;
  }, [sessionManager]);

  return sessions;
}
