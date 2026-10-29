import { useEffect, useState } from 'react';

/**
 * 1 Hz wall-clock for elapsed-time displays. Ticks only while `active` and clears its interval the
 * moment it goes inactive, so a settled view stops re-rendering every second. `seed` is the
 * initial value only (default `Date.now()`); once mounted the consumer free-runs on its own tick.
 */
export const useTickingClock = (active: boolean, seed?: number): number => {
  const [now, setNow] = useState<number>(() => seed ?? Date.now());
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
