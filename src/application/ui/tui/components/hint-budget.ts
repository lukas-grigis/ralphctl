/** Width-budgeted hint fitting for the one-row footer strip. Pure: no React, no Ink. */

import { glyphs } from '@src/application/ui/tui/theme/tokens.ts';

export interface FitHint {
  readonly keys: string;
  readonly label: string;
}

export interface FitHintsResult {
  /** Hints that fit, in input order; ends with the `… ? more` cell iff `dropped` is non-empty. */
  readonly visible: readonly FitHint[];
  readonly dropped: readonly FitHint[];
}

/** The overflow cell: `… ? more`. */
export const MORE_HINT: FitHint = { keys: glyphs.clipEllipsis, label: '? more' };

const SEPARATOR = ` ${glyphs.bullet} `;

const cellText = (h: FitHint): string => `${h.keys} ${h.label}`;

const cellWidth = (h: FitHint): number => [...cellText(h)].length;

const SEPARATOR_WIDTH = [...SEPARATOR].length;

/** Code-point width of `hints` joined with the separator. */
export const joinedWidth = (hints: readonly FitHint[]): number =>
  hints.reduce((sum, h, i) => sum + cellWidth(h) + (i > 0 ? SEPARATOR_WIDTH : 0), 0);

export const fitHints = (hints: readonly FitHint[], width: number): FitHintsResult => {
  if (joinedWidth(hints) <= width) return { visible: hints, dropped: [] };

  const reserve = SEPARATOR_WIDTH + cellWidth(MORE_HINT);
  const taken: FitHint[] = [];
  let used = 0;
  for (const h of hints) {
    const next = used + cellWidth(h) + (taken.length > 0 ? SEPARATOR_WIDTH : 0);
    if (next + reserve > width) break;
    taken.push(h);
    used = next;
  }
  return { visible: [...taken, MORE_HINT], dropped: hints.slice(taken.length) };
};
