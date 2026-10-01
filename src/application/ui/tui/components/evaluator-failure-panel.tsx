/** EvaluatorFailurePanel — per-dimension verdict view for one attempt's evaluation. */

import React from 'react';
import { Box, Text } from 'ink';
import type { ParsedEvaluation, ParsedDimensionVerdict } from '@src/business/task/parse-evaluation-md.ts';
import { glyphs, inkColors } from '@src/application/ui/tui/theme/tokens.ts';

/** Hard cap on a single projected row. */
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

/** Glyph + color per dimension verdict. */
const VERDICT_PRESENTATION: Record<ParsedDimensionVerdict, { readonly glyph: string; readonly color?: string }> = {
  passed: { glyph: glyphs.check, color: inkColors.success },
  failed: { glyph: glyphs.cross, color: inkColors.error },
  'n/a': { glyph: glyphs.bullet },
  unknown: { glyph: glyphs.unknownGlyph },
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
 * Flatten a parsed evaluation into styled rows, in reading order: verdict, timestamp, critique, then one block per
 * dimension.
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
 * Render a run of projected rows. Shared by the panel and the overlay's windowed body so the two cannot style the
 * same model differently.
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
