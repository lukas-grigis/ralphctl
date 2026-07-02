/**
 * 1 Hz clock scoped to a single task card's idle-ticker leaf (`IdleTickerNotice` in
 * `task-row.tsx`). Mirrors `execute-view-internals/elapsed-label.tsx`'s `useLiveClock` pattern —
 * kept as a local copy rather than a cross-view import, since `tasks-panel-internals` is a
 * shared component tree (consumed by more than just the Execute view) and each 1 Hz consumer
 * should own its own tiny timer rather than share one through prop-drilling.
 *
 * Ticks only while `active` — a card that isn't the panel's running/focused task never starts an
 * interval, so only the one active card (at most) pays for a timer at any moment. `seed` is used
 * as the initial value only (the caller's freshest known "now", e.g. the host's last poll tick);
 * once mounted the leaf free-runs on its own, so a parent re-render is never required to keep the
 * idle-ticker accurate.
 */

import { useEffect, useState } from 'react';

export const useIdleClock = (active: boolean, seed: number): number => {
  const [now, setNow] = useState<number>(seed);
  useEffect(() => {
    if (!active) return undefined;
    const id = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      clearInterval(id);
    };
  }, [active]);
  return now;
};
