/**
 * `y` on the Execute view — copy the markdown summary of the task being watched and confirm with
 * a short-lived info banner. Execute-local: nothing outside this view binds `y`, so there is no
 * "no active task" toast to explain a dead key.
 *
 * The banner id is stable, so re-presses replace the toast instead of stacking, and the pending
 * clear timer is cancelled by the latest copy (and on unmount).
 */

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { createCopyToClipboard } from '@src/integration/io/clipboard.ts';
import { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type { EventBus } from '@src/business/observability/event-bus.ts';

const CLIPBOARD_TOAST_DURATION_MS = 2000;
const CLIPBOARD_BANNER_ID = 'clipboard-copy';

interface UseYankTaskInput {
  readonly eventBus: EventBus;
  /** Renders the focused task's markdown, or `undefined` when there is no active task. */
  readonly getSummary: () => string | undefined;
}

/** Returns the `y` handler. A no-op while `getSummary` has nothing to copy. */
export const useYankTask = ({ eventBus, getSummary }: UseYankTaskInput): (() => void) => {
  const copyToClipboard = useMemo(() => createCopyToClipboard(), []);
  const clearTimer = useRef<NodeJS.Timeout | undefined>(undefined);
  useEffect(
    () => () => {
      if (clearTimer.current !== undefined) clearTimeout(clearTimer.current);
    },
    []
  );

  return useCallback((): void => {
    const summary = getSummary();
    if (summary === undefined) return;
    const show = (tier: 'info' | 'warn', message: string, cause?: string): void => {
      eventBus.publish({
        type: 'banner-show',
        id: CLIPBOARD_BANNER_ID,
        tier,
        message,
        ...(cause !== undefined ? { cause } : {}),
        at: IsoTimestamp.now(),
      });
      if (clearTimer.current !== undefined) clearTimeout(clearTimer.current);
      clearTimer.current = setTimeout(() => {
        eventBus.publish({ type: 'banner-clear', id: CLIPBOARD_BANNER_ID, at: IsoTimestamp.now() });
        clearTimer.current = undefined;
      }, CLIPBOARD_TOAST_DURATION_MS);
    };
    void (async (): Promise<void> => {
      const result = await copyToClipboard(summary);
      if (result.ok) show('info', 'Copied to clipboard');
      else show('warn', 'Clipboard copy failed', result.error.message);
    })();
  }, [copyToClipboard, eventBus, getSummary]);
};
