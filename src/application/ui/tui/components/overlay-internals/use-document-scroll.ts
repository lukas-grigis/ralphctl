/** Scroll model shared by the read-only document overlays (`ProgressOverlay`, `EvaluationOverlay`). */

import { useEffect, useState } from 'react';
import { useInput } from 'ink';

export interface DocumentScroll {
  readonly offset: number;
  readonly maxOffset: number;
  readonly visibleLines: number;
}

export const useDocumentScroll = (lineCount: number, bodyRows: number): DocumentScroll => {
  const [offset, setOffset] = useState<number>(0);

  useEffect(() => {
    setOffset(0);
  }, [lineCount]);

  const maxOffset = Math.max(0, lineCount - bodyRows);
  const clamp = (n: number): number => Math.max(0, Math.min(n, maxOffset));

  useInput((input, key) => {
    // Only scroll when there's an actual document and it overflows the viewport.
    if (maxOffset === 0) return;
    if (key.upArrow) {
      setOffset((o) => clamp(o - 1));
      return;
    }
    if (key.downArrow) {
      setOffset((o) => clamp(o + 1));
      return;
    }
    if (key.pageUp || (key.ctrl && input === 'b')) {
      setOffset((o) => clamp(o - bodyRows));
      return;
    }
    if (key.pageDown || (key.ctrl && input === 'f')) {
      setOffset((o) => clamp(o + bodyRows));
      return;
    }
    if (key.ctrl && input === 'u') {
      setOffset((o) => clamp(o - Math.max(1, Math.floor(bodyRows / 2))));
      return;
    }
    if (key.ctrl && input === 'd') {
      setOffset((o) => clamp(o + Math.max(1, Math.floor(bodyRows / 2))));
    }
  });

  return { offset, maxOffset, visibleLines: Math.min(bodyRows, Math.max(0, lineCount - offset)) };
};

/** Reserve rows for banners + header + footer chrome around a scrollable overlay body. */
export const OVERLAY_CHROME_ROWS = 10;
/** Floor on the scrollable body so a tiny terminal still shows something useful. */
export const OVERLAY_MIN_BODY_ROWS = 6;

/** Viewport height for an overlay body on a terminal of `termRows` rows. */
export const overlayBodyRows = (termRows: number): number =>
  Math.max(OVERLAY_MIN_BODY_ROWS, termRows - OVERLAY_CHROME_ROWS);
