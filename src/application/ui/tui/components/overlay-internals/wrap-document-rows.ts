/** Hard-wrap helper shared by the read-only document overlays (`ProgressOverlay`, `EvaluationOverlay`). */

import { spacing } from '@src/application/ui/tui/theme/tokens.ts';

/**
 * Columns the overlay chrome eats before the body gets any: the outer `paddingX`, the rounded border, and the inner
 * `paddingX` — each on both sides.
 */
export const OVERLAY_CHROME_COLUMNS = spacing.indent * 2 + 2 + spacing.indent * 2;

/** Floor on the wrap width so a pathologically narrow terminal still wraps into something. */
export const OVERLAY_MIN_BODY_COLUMNS = 20;

/** Usable body width for an overlay row on a terminal of `termColumns` columns. */
export const overlayBodyColumns = (termColumns: number): number =>
  Math.max(OVERLAY_MIN_BODY_COLUMNS, termColumns - OVERLAY_CHROME_COLUMNS);

/**
 * Below this many usable columns a continuation indent costs more than it buys, so continuation rows start at column
 * 0 instead of under the parent's indent.
 */
const MIN_CONTINUATION_WIDTH = 8;

/** Chop a row that cannot be word-wrapped (leading whitespace alone exceeds the width). */
const hardSplit = (text: string, width: number): readonly string[] => {
  const rows: string[] = [];
  for (let i = 0; i < text.length; i += width) rows.push(text.slice(i, i + width));
  return rows;
};

/**
 * Word-wrap one row to `width` columns. Continuation rows repeat the source row's leading whitespace so an indented
 * finding stays visually attached to its heading.
 */
export const wrapRow = (text: string, width: number): readonly string[] => {
  if (width <= 0 || text.length <= width) return [text];

  const leading = /^[ \t]*/.exec(text)?.[0] ?? '';
  const firstWidth = width - leading.length;
  if (firstWidth <= 0) return hardSplit(text, width);
  const indent = leading.length + MIN_CONTINUATION_WIDTH <= width ? leading : '';

  const rows: string[] = [];
  let prefix = leading;
  let avail = firstWidth;
  let line = '';
  const flush = (): void => {
    rows.push(prefix + line);
    prefix = indent;
    avail = width - indent.length;
    line = '';
  };

  for (const word of text.slice(leading.length).split(' ')) {
    const candidate = line.length === 0 ? word : `${line} ${word}`;
    if (candidate.length <= avail) {
      line = candidate;
      continue;
    }
    if (line.length > 0) flush();
    let rest = word;
    while (rest.length > avail) {
      line = rest.slice(0, avail);
      rest = rest.slice(avail);
      flush();
    }
    line = rest;
  }
  if (line.length > 0 || rows.length === 0) rows.push(prefix + line);
  return rows;
};

/** {@link wrapRow} over a whole document. */
export const wrapRows = (rows: readonly string[], width: number): readonly string[] =>
  rows.flatMap((row) => wrapRow(row, width));
