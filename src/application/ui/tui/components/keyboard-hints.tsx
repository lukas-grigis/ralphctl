/**
 * Inline rendering of a hint set: `↵ select  ·  esc back`. Used inside the status bar and
 * occasionally inside cards for local affordances.
 */

import React from 'react';
import { Text } from 'ink';
import { glyphs, inkColors } from '@src/application/ui/tui/theme/tokens.ts';
import type { ViewHint } from '@src/application/ui/tui/runtime/use-view-hints.tsx';

export interface KeyboardHintsProps {
  readonly hints: readonly ViewHint[];
  readonly separator?: string;
}

const SEPARATOR = ` ${glyphs.bullet} `;

const hintWidth = (h: ViewHint): number => [...h.keys].length + 1 + [...h.label].length;

const stripWidth = (hints: readonly ViewHint[]): number =>
  hints.reduce((sum, h, i) => sum + hintWidth(h) + (i > 0 ? [...SEPARATOR].length : 0), 0);

/**
 * Fit a hint strip into `width` cells by dropping whole hints rather than clipping one mid-word. The
 * first `keep` hints (the view's own actions) and any hint whose `keys` is in `pinned` (`? help`, quit)
 * are never dropped; the rest go right to left. A strip still too wide after that is clipped by the renderer.
 */
export const fitHints = (
  hints: readonly ViewHint[],
  width: number,
  keep: number,
  pinned: ReadonlySet<string> = new Set()
): readonly ViewHint[] => {
  const kept = [...hints];
  for (let i = kept.length - 1; i >= keep && stripWidth(kept) > width; i--) {
    if (!pinned.has(kept[i]?.keys ?? '')) kept.splice(i, 1);
  }
  return kept;
};

export const KeyboardHints = ({ hints, separator = SEPARATOR }: KeyboardHintsProps): React.JSX.Element => {
  if (hints.length === 0) return <Text dimColor />;
  // One truncating Text, not a row of Boxes: an overflowing row of Boxes shrinks each hint until
  // it wraps into one-letter columns; a single Text clips at the end of the one line instead.
  return (
    <Text wrap="truncate-end">
      {hints.map((h, i) => (
        <Text key={`${h.label}-${String(i)}`}>
          {i > 0 && <Text dimColor>{separator}</Text>}
          <Text color={inkColors.primary} bold>
            {h.keys}
          </Text>
          <Text dimColor> {h.label}</Text>
        </Text>
      ))}
    </Text>
  );
};
