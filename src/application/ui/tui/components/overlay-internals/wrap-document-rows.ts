/**
 * Hard-wrap helper shared by the read-only document overlays (`ProgressOverlay`,
 * `EvaluationOverlay`).
 *
 * Both overlays window an on-disk artifact by ROW COUNT — they slice `lines[offset, offset +
 * bodyRows]` and derive `maxOffset` from `lines.length`. That arithmetic is only sound when one
 * array entry paints exactly one terminal row. It does not hold for the raw artifacts: an
 * `evaluation.md` critique and a `progress.md` note are each written as ONE unwrapped paragraph,
 * which Ink's default `wrap="wrap"` happily paints across 4–8 rows. The overlay then overflows
 * the fixed-height app frame (garbling the closing border) while `maxOffset` stays 0, so
 * `useDocumentScroll` early-returns on every keystroke and the clipped tail is unreachable.
 *
 * Wrapping here — before windowing — makes the two agree again, and unlike `truncate-end` alone
 * it loses no prose (these overlays exist to READ prose and there is no horizontal scroll).
 * `truncate-end` still rides on the `<Text>` as the belt-and-braces guarantee that a row we
 * mis-measured (tabs, wide glyphs) can never spill onto a second line.
 *
 * Width is measured in code points, not display cells: the alternative is a `string-width`
 * dependency we don't carry, and the `truncate-end` backstop already bounds the failure mode to
 * "a wide-glyph row wraps a little early" rather than "the viewport arithmetic breaks".
 */

import { spacing } from '@src/application/ui/tui/theme/tokens.ts';

/**
 * Columns the overlay chrome eats before the body gets any: the outer `paddingX`, the rounded
 * border, and the inner `paddingX` — each on both sides. Keep in step with the frame both
 * overlays render (outer Box `paddingX={spacing.indent}` → bordered Box `paddingX={spacing.indent}`).
 */
export const OVERLAY_CHROME_COLUMNS = spacing.indent * 2 + 2 + spacing.indent * 2;

/** Floor on the wrap width so a pathologically narrow terminal still wraps into something. */
export const OVERLAY_MIN_BODY_COLUMNS = 20;

/** Usable body width for an overlay row on a terminal of `termColumns` columns. */
export const overlayBodyColumns = (termColumns: number): number =>
  Math.max(OVERLAY_MIN_BODY_COLUMNS, termColumns - OVERLAY_CHROME_COLUMNS);

/**
 * Below this many usable columns a continuation indent costs more than it buys, so continuation
 * rows start at column 0 instead of under the parent's indent.
 */
const MIN_CONTINUATION_WIDTH = 8;

/** Chop a row that cannot be word-wrapped (leading whitespace alone exceeds the width). */
const hardSplit = (text: string, width: number): readonly string[] => {
  const rows: string[] = [];
  for (let i = 0; i < text.length; i += width) rows.push(text.slice(i, i + width));
  return rows;
};

/**
 * Word-wrap one row to `width` columns. Continuation rows repeat the source row's leading
 * whitespace so an indented finding stays visually attached to its heading. A single word longer
 * than the width (a URL, a base64 blob) is chopped rather than allowed to overflow.
 *
 * Interior runs of spaces are preserved verbatim — evidence blocks use them for alignment.
 * An empty row wraps to a single empty row, keeping the artifact's blank-line rhythm.
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
