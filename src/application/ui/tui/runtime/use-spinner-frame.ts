/**
 * Animation frame counter for the braille spinner. One shared timer per process — every panel
 * that wants a spinner reads the same frame so they tick in lock-step (visually calmer than
 * each spinner running its own timer).
 */

import { useEffect, useState } from 'react';
import { glyphs } from '@src/application/ui/tui/theme/tokens.ts';

const FRAME_INTERVAL_MS = 90;

export const useSpinnerFrame = (active = true): number => {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (!active) return undefined;
    const id = setInterval(() => {
      setFrame((f) => (f + 1) % glyphs.spinner.length);
    }, FRAME_INTERVAL_MS);
    return () => {
      clearInterval(id);
    };
  }, [active]);
  return frame;
};

export const spinnerGlyph = (frame: number): string => glyphs.spinner[frame % glyphs.spinner.length] ?? '⠋';
