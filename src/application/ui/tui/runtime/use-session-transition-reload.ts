/**
 * `useSessionTransitionReload` — calls `reload` whenever a tracked session's status changes (or it is removed), so a
 * view doesn't stay frozen on the sprint state from launch time. It diffs statuses to skip the per-step notifies.
 */

import { useEffect, useRef } from 'react';
import { useSessionManager } from '@src/application/ui/tui/runtime/sessions-context.tsx';

export const useSessionTransitionReload = (reload: () => void): void => {
  const sessionMgr = useSessionManager();

  // `reload` is a fresh closure each render (no useCallback in useAsyncLoad), so we route it
  // through a ref to keep the subscription stable.
  const reloadRef = useRef(reload);
  reloadRef.current = reload;

  useEffect(() => {
    const snapshot = (): Map<string, string> => {
      const m = new Map<string, string>();
      for (const rec of sessionMgr.list()) m.set(rec.descriptor.id, rec.descriptor.status);
      return m;
    };
    let prev = snapshot();
    return sessionMgr.subscribe(() => {
      const next = snapshot();
      let changed = prev.size !== next.size;
      if (!changed) {
        for (const [id, status] of next) {
          if (prev.get(id) !== status) {
            changed = true;
            break;
          }
        }
      }
      prev = next;
      if (changed) reloadRef.current();
    });
  }, [sessionMgr]);
};
