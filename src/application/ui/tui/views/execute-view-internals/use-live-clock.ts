/**
 * 1-Hz live clock used by the execute view for elapsed-time formatting + cancel-scope
 * stats. Ticks while `isRunning` is true; pauses (clearInterval) the moment the run
 * settles so a finished view stops re-rendering every second.
 */

import { useEffect, useState } from 'react';

export const useLiveClock = (isRunning: boolean): number => {
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    if (!isRunning) return undefined;
    const id = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      clearInterval(id);
    };
  }, [isRunning]);
  return now;
};
