/**
 * React hooks bridging the non-React event buses (logEventBus,
 * SessionManagerPort) and the Ink component tree.
 *
 * Ported from src/integration/ui/tui/runtime/hooks.ts — adapted for
 * src with SessionManager instead of ExecutionRegistryPort.
 */

import { useEffect, useState } from 'react';
import type { LogEvent } from '../../../integration/logging/log-event-bus.ts';
import type { SessionManagerPort, SessionDescriptor } from '../../runtime/session-manager-port.ts';
import { logEventBus } from './event-bus.ts';

/**
 * Subscribe to log events. Returns a rolling buffer of the most recent
 * events up to `limit` (default 200). The buffer is a new array on every
 * update so React re-renders correctly.
 */
export function useLoggerEvents(limit = 200): readonly LogEvent[] {
  const [buffer, setBuffer] = useState<LogEvent[]>([]);

  useEffect(() => {
    setBuffer([]);
    const unsubscribe = logEventBus.subscribe((event) => {
      setBuffer((prev) => {
        const next = [...prev, event];
        if (next.length > limit) next.splice(0, next.length - limit);
        return next;
      });
    });
    return unsubscribe;
  }, [limit]);

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
