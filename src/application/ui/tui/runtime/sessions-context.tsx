/**
 * Provides the {@link SessionManager} via React context plus a hook that re-renders on every registry change.
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

/** `undefined` outside a provider — for passive surfaces that merely annotate a session. */
export const useOptionalSessionManager = (): SessionManager | undefined => useContext(SessionsContext);

/**
 * Build an id→signature map for the registry. The signature folds in status, error presence, and the pinned-sprint
 * identity.
 */
const sigOf = (descriptor: SessionRecord['descriptor']): string =>
  `${descriptor.status}|${descriptor.error ? '1' : '0'}|${descriptor.pinnedSprintId ?? ''}|${descriptor.pinnedSprintLabel ?? ''}`;

const sessionsSignature = (records: readonly SessionRecord[]): Map<string, string> => {
  const m = new Map<string, string>();
  for (const rec of records) {
    m.set(rec.descriptor.id, sigOf(rec.descriptor));
  }
  return m;
};

const sameSignature = (prev: Map<string, string>, next: Map<string, string>): boolean => {
  if (prev.size !== next.size) return false;
  for (const [id, sig] of next) {
    if (prev.get(id) !== sig) return false;
  }
  return true;
};

/**
 * Re-render the caller whenever the session registry changes in a status-relevant way. Returns the current snapshot.
 */
export const useSessions = (): readonly SessionRecord[] => {
  const mgr = useSessionManager();
  const [snapshot, setSnapshot] = useState<readonly SessionRecord[]>(() => mgr.list());
  useEffect(() => {
    let prev = sessionsSignature(mgr.list());
    setSnapshot(mgr.list());
    return mgr.subscribe(() => {
      const list = mgr.list();
      const next = sessionsSignature(list);
      if (!sameSignature(prev, next)) {
        prev = next;
        setSnapshot(list);
      }
    });
  }, [mgr]);
  return snapshot;
};

/**
 * Re-render whenever the named session's status, error presence, or pinned sprint changes. Returns `undefined` when
 * unknown.
 */
export const useSession = (id: string | undefined): SessionRecord | undefined => {
  const mgr = useSessionManager();
  const [record, setRecord] = useState<SessionRecord | undefined>(() => (id ? mgr.get(id) : undefined));
  useEffect(() => {
    if (!id) {
      setRecord(undefined);
      return undefined;
    }
    const sig = (rec: SessionRecord | undefined): string => (rec ? sigOf(rec.descriptor) : 'absent');
    let prev = sig(mgr.get(id));
    setRecord(mgr.get(id));
    return mgr.subscribe(() => {
      const rec = mgr.get(id);
      const next = sig(rec);
      if (next !== prev) {
        prev = next;
        setRecord(rec);
      }
    });
  }, [mgr, id]);
  return record;
};
