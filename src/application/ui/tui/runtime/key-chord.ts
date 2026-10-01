/** Ctrl / Alt chords: never a plain keystroke, so a single-letter binding must not fire on one. */

import type { Key } from 'ink';

/** Ink flags Esc with `meta` on some terminals; Esc is not a chord. */
export const isChord = (key: Pick<Key, 'ctrl' | 'meta' | 'escape'>): boolean => key.ctrl || (key.meta && !key.escape);
