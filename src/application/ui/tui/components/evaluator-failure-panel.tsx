/**
 * EvaluatorFailurePanel — per-dimension verdict view for one attempt's evaluation.
 *
 * Source of truth is the on-disk `evaluation.md` artifact, parsed by `parseEvaluationMarkdown`.
 * It used to read the timestamp-windowed `TaskBucket.evaluations` signal stream, which
 * mis-attributes evaluator signals across lanes under parallel sprints — which is why the panel
 * spent its whole life behind a developer flag instead of on screen. Reading the artifact the
 * evaluator actually wrote for the attempt removes that ambiguity, and with it the flag.
 *
 * The panel is the body of {@link EvaluationOverlay}. Because an `evaluation.md` can be arbitrarily
 * long, the panel does NOT own its own scroll: it projects to a flat list of styled lines
 * ({@link projectEvaluationLines}) so the overlay can window that list by row count. Windowing a
 * React subtree is not possible; windowing a line array is trivial.
 *
 * Layout:
 *
 *   eval  failed
 *   2026-08-17T09:15:00.000Z
 *
 *   critique
 *     The legacy migration path is untested.
 *
 *   ✓ correctness: passed
 *       Logic matches the acceptance criteria.
 *   ✗ tests: failed
 *       No regression test for the legacy row.
 *       ↳ FAIL tests/unit/foo.test.ts
 *   · docs: n/a
 *       No documentation surface in scope.
 *
 * No keyboard affordance of its own. The earlier `d`-to-expand chord double-fired with
 * `StatusBanner`'s ungated global `d` (dismiss top banner), and in a scrollable overlay a critique
 * excerpt is pointless — the full body is one PgDn away.
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { ParsedEvaluation, ParsedDimensionVerdict } from '@src/business/task/parse-evaluation-md.ts';
import { glyphs, inkColors } from '@src/application/ui/tui/theme/tokens.ts';

/**
 * Hard cap on a single projected row. Ink wraps a `<Text>` across as many terminal rows as it
 * needs, so one pathological 200 kB line inside a fenced evidence block would defeat the overlay's
 * row-count windowing and paint the whole screen. Generous enough that no real critique or command
 * output is clipped in practice.
 */
const MAX_LINE_CHARS = 2000;

/** One projected row: plain text plus the styling the overlay / panel applies verbatim. */
export interface EvaluationLineSpec {
  readonly text: string;
  readonly color?: string;
  readonly dim?: boolean;
  readonly bold?: boolean;
}

/** Verdict-line color by evaluation status — read once instead of a nested ternary. */
const STATUS_COLOR: Record<ParsedEvaluation['status'], string> = {
  failed: inkColors.error,
  passed: inkColors.success,
  malformed: inkColors.warning,
  unknown: inkColors.muted,
};

/**
 * Glyph + color per dimension verdict. `n/a` and `unknown` are deliberately NEITHER red nor green:
 * the renderer emits `n/a` for a dimension the evaluator marked not-applicable (which carries
 * `passed: false` in the source signal), so keying off a boolean painted every N/A dimension as a
 * red failure — a real misreport this panel used to produce.
 */
const VERDICT_PRESENTATION: Record<ParsedDimensionVerdict, { readonly glyph: string; readonly color?: string }> = {
  passed: { glyph: glyphs.check, color: inkColors.success },
  failed: { glyph: glyphs.cross, color: inkColors.error },
  'n/a': { glyph: glyphs.bullet },
  unknown: { glyph: '?' },
};

const clip = (text: string): string =>
  text.length <= MAX_LINE_CHARS ? text : `${text.slice(0, MAX_LINE_CHARS)}${glyphs.clipEllipsis}`;

/** Split a prose block into rows at the given indent, clipping each. Empty input contributes none. */
const proseRows = (text: string, indent: string, spec: Omit<EvaluationLineSpec, 'text'>): EvaluationLineSpec[] =>
  text.length === 0 ? [] : text.split('\n').map((line) => ({ text: clip(`${indent}${line}`), ...spec }));

const dimensionRows = (dimension: ParsedEvaluation['dimensions'][number]): EvaluationLineSpec[] => {
  const { glyph, color } = VERDICT_PRESENTATION[dimension.verdict];
  const heading: EvaluationLineSpec = {
    text: clip(`${glyph} ${dimension.dimension}: ${dimension.verdict}`),
    ...(color !== undefined ? { color } : { dim: true }),
  };
  return [
    heading,
    ...proseRows(dimension.finding, '    ', { dim: true }),
    ...proseRows(dimension.evidence ?? '', `    ${glyphs.activityArrow} `, { dim: true }),
  ];
};

/**
 * Flatten a parsed evaluation into styled rows, in reading order: verdict, timestamp, critique,
 * then one block per dimension. The overlay slices this array to its viewport; the panel renders
 * all of it. Returns an empty array for a model with nothing in it, which is the signal the
 * overlay uses to fall back to the raw file.
 */
export const projectEvaluationLines = (parsed: ParsedEvaluation): readonly EvaluationLineSpec[] => {
  const hasContent = parsed.status !== 'unknown' || parsed.critique !== undefined || parsed.dimensions.length > 0;
  if (!hasContent) return [];

  const rows: EvaluationLineSpec[] = [
    { text: `eval  ${parsed.status}`, color: STATUS_COLOR[parsed.status], bold: true },
  ];
  if (parsed.timestamp !== undefined) rows.push({ text: clip(parsed.timestamp), dim: true });
  if (parsed.critique !== undefined) {
    rows.push({ text: '' }, { text: 'critique', bold: true }, ...proseRows(parsed.critique, '  ', {}));
  }
  if (parsed.dimensions.length > 0) {
    rows.push({ text: '' });
    for (const dimension of parsed.dimensions) rows.push(...dimensionRows(dimension));
  }
  return rows;
};

/**
 * Render a run of projected rows. Shared by the panel and the overlay's windowed body so the two
 * cannot style the same model differently. `keyPrefix` disambiguates when the caller renders a
 * SLICE — row indices restart at 0 on every scroll otherwise.
 *
 * `oneRowPerLine` is for the WINDOWING caller: it clips each row with `truncate-end` so a spec
 * can never paint across two terminal rows and desync a row-count viewport. The overlay pairs it
 * with a pre-wrap (`wrap-document-rows.ts`) so nothing is actually lost; a caller that renders
 * the whole projection (the panel below) leaves it off and lets Ink reflow the prose.
 *
 * @public
 */
export const EvaluationLines = ({
  lines,
  keyOffset = 0,
  oneRowPerLine = false,
}: {
  readonly lines: readonly EvaluationLineSpec[];
  readonly keyOffset?: number;
  readonly oneRowPerLine?: boolean;
}): React.JSX.Element => (
  <Box flexDirection="column">
    {lines.map((line, idx) => (
      <Text
        key={`eval-line-${String(keyOffset + idx)}`}
        {...(oneRowPerLine ? ({ wrap: 'truncate-end' } as const) : {})}
        {...(line.color !== undefined ? { color: line.color } : {})}
        {...(line.dim === true ? { dimColor: true } : {})}
        {...(line.bold === true ? { bold: true } : {})}
      >
        {line.text.length === 0 ? ' ' : line.text}
      </Text>
    ))}
  </Box>
);

export const EvaluatorFailurePanel = ({ parsed }: { readonly parsed: ParsedEvaluation }): React.JSX.Element => (
  <EvaluationLines lines={projectEvaluationLines(parsed)} />
);
