/**
 * Colour opt-out, shared by the launcher (which forces chalk to level 0) and `useNoColor` (which swaps colour-only
 * cues for shapes).
 */

import { useMemo } from 'react';

export const isColorDisabled = (env: NodeJS.ProcessEnv = process.env): boolean =>
  (env['NO_COLOR'] ?? '') !== '' || env['TERM'] === 'dumb';

/** Read once on mount — the env does not change while the TUI runs. */
export const useNoColor = (): boolean => useMemo(() => isColorDisabled(), []);
