/** Transient feedback for Work's pinned feedback row: a flash, a launch error, or the switch toast. */

import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import type { StructuredFeedback } from '@src/application/ui/tui/components/feedback-line.tsx';
import type { useSelection } from '@src/application/ui/tui/runtime/selection-context.tsx';

const FEEDBACK_MS = 3000;

/** A message that clears itself; a re-flash restarts the clock. */
export const useFlash = (): {
  readonly flash: StructuredFeedback | undefined;
  readonly show: (f: StructuredFeedback) => void;
} => {
  const [flash, setFlash] = useState<StructuredFeedback | undefined>(undefined);
  const timerRef = useRef<NodeJS.Timeout | undefined>(undefined);
  const show = useCallback((f: StructuredFeedback): void => {
    setFlash(f);
    if (timerRef.current !== undefined) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      setFlash(undefined);
      timerRef.current = undefined;
    }, FEEDBACK_MS);
  }, []);
  useEffect(
    () => (): void => {
      if (timerRef.current !== undefined) clearTimeout(timerRef.current);
    },
    []
  );
  return { flash, show };
};

/** `now on <sprint>` for a few seconds after any sprint switch. */
export const useSwitchToast = (selection: ReturnType<typeof useSelection>): StructuredFeedback | undefined => {
  const [, forceRender] = useReducer((n: number) => n + 1, 0);
  const lastSwitch = selection.lastSwitch;
  useEffect(() => {
    if (lastSwitch === undefined) return undefined;
    const remaining = FEEDBACK_MS - (Date.now() - lastSwitch.at);
    if (remaining <= 0) return undefined;
    // A real reducer bump: an identity setState bails out and the toast would stay painted.
    const id = setTimeout(forceRender, remaining + 50);
    return (): void => clearTimeout(id);
  }, [lastSwitch]);
  const visible =
    lastSwitch !== undefined && Date.now() - lastSwitch.at < FEEDBACK_MS && lastSwitch.sprintId === selection.sprintId;
  return visible ? { tone: 'success', text: `now on ${lastSwitch.sprintLabel}` } : undefined;
};
