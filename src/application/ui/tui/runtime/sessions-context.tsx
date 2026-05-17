/**
 * Provides the {@link SessionManager} via React context plus a hook that re-renders on every
 * registry change. Views that show "active sessions" or stream a single session's events use
 * the hook so they pick up new runs without prop drilling.
 */

import React, { createContext, useContext, useEffect, useState } from 'react';
import type { SessionManager, SessionRecord } from '@src/application/ui/tui/runtime/session-manager.ts';

const SessionsContext = createContext<SessionManager | undefined>(undefined);

export interface SessionsProviderProps {
  readonly value: SessionManager;
  readonly children: React.ReactNode;
}

export const SessionsProvider = ({ value, children }: SessionsProviderProps): React.JSX.Element => (
  <SessionsContext.Provider value={value}>{children}</SessionsContext.Provider>
);

export const useSessionManager = (): SessionManager => {
  const ctx = useContext(SessionsContext);
  if (!ctx) throw new Error('useSessionManager: must be used inside <SessionsProvider>');
  return ctx;
};

/** Re-render the caller whenever the session registry changes. Returns the current snapshot. */
export const useSessions = (): readonly SessionRecord[] => {
  const mgr = useSessionManager();
  const [snapshot, setSnapshot] = useState<readonly SessionRecord[]>(() => mgr.list());
  useEffect(() => {
    setSnapshot(mgr.list());
    return mgr.subscribe(() => {
      setSnapshot(mgr.list());
    });
  }, [mgr]);
  return snapshot;
};

/** Re-render whenever the named session's descriptor changes. Returns `undefined` when unknown. */
export const useSession = (id: string | undefined): SessionRecord | undefined => {
  const mgr = useSessionManager();
  const [record, setRecord] = useState<SessionRecord | undefined>(() => (id ? mgr.get(id) : undefined));
  useEffect(() => {
    if (!id) {
      setRecord(undefined);
      return undefined;
    }
    setRecord(mgr.get(id));
    return mgr.subscribe(() => {
      setRecord(mgr.get(id));
    });
  }, [mgr, id]);
  return record;
};
