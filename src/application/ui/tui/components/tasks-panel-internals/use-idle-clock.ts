/** 1 Hz clock scoped to a single task card's idle-ticker leaf (`IdleTickerNotice` in `task-row.tsx`). */

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
