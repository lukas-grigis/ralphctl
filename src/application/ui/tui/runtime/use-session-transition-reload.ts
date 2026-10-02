/**
 * `useSessionTransitionReload` — calls `reload` whenever a tracked session's status transitions
 * (registered, running → completed / failed / aborted, or removed) so a view rendering
 * sprint-derived state doesn't stay frozen on the snapshot that was current when the flow was
 * LAUNCHED. A flow (refine, plan, implement, …) mutates sprint/ticket/task state on disk only
 * once it finishes — minutes after launch — and nothing else invalidates a `useAsyncLoad` keyed
 * on selection ids, so without this subscription the flows menu and home overview keep showing
 * launch-time counts (e.g. "refine tickets (N pending)") until the user manually presses `r`.
 *
 * Shared by `useAppStateSnapshot` (flows-view, home-view) and `useSprintBundle` (sprint-detail),
 * which is where this subscription originated.
 *
 * We diff session statuses rather than reloading on every `notify()` because the session manager
 * fires on every chain `step`, and those trace-only updates leave every descriptor's status
 * untouched — reloading on those would hammer disk for a rail update no consumer here renders.
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
