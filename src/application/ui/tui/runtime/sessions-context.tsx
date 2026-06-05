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

/**
 * Build an id→signature map for the registry. The signature folds in status, error presence, and
 * the pinned-sprint identity. Trace-only `step` notifies mutate the descriptor's `trace` but never
 * any of these fields, so two snapshots with the same signature are render-equivalent. The pinned
 * sprint IS included: a `setPinnedSprint` mid-run (create-sprint) changes no status but must
 * re-render so the execute view drops the stale (undefined) sprint. `trace` is deliberately
 * EXCLUDED — the live flow-steps rail stays current via the shared-mutable trace array plus the
 * sibling chainEvents re-render, and adding it here would re-introduce the per-step render storm.
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
 * Re-render the caller whenever the session registry changes in a status-relevant way. Returns
 * the current snapshot.
 *
 * Guarded with a status-diff (mirroring `use-sprint-bundle.ts`): the session manager fires
 * `notify()` on every chain `step`, but those trace-only updates leave each descriptor's
 * status/error untouched. We only `setState` when set-membership or a status/error actually
 * changed — otherwise the always-mounted StatusBar would re-render once per leaf step.
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
 * Re-render whenever the named session's status, error presence, or pinned sprint changes.
 * Returns `undefined` when unknown. Trace-only `step` notifies are ignored — see {@link
 * useSessions}.
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
