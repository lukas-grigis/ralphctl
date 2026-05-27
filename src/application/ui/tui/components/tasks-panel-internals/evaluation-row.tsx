/**
 * Per-evaluation row + criterion fusion logic for the Tasks panel.
 *
 * When the criterion count matches the evaluator's dimension count we pair them positionally
 * (the AI prompt already encourages this). Mismatched counts fall through to the per-dimension
 * row rendering rather than fabricate attribution.
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { EvaluationSignal } from '@src/domain/signal.ts';
import { glyphs, inkColors } from '@src/application/ui/tui/theme/tokens.ts';
import { fmtIsoTime } from '@src/application/ui/tui/theme/duration.ts';
import { collapseWhitespace } from '@src/application/ui/tui/components/tasks-panel-internals/format.ts';

/**
 * Per-criterion verdict mapping is deterministic only when the criterion count and the
 * evaluator's dimension count match — in that case we pair them positionally, which is what
 * the AI prompt already encourages. When counts diverge, we fall back to the per-dimension
 * row rendering rather than fabricate attribution. Returns the rendered text bullets, one
 * per criterion, paired with the dimension's pass flag.
 */
interface CriterionVerdictRow {
  readonly criterion: string;
  readonly passed: boolean;
}

const fuseCriteriaWithDimensions = (
  criteria: readonly string[],
  dimensions: EvaluationSignal['dimensions']
): readonly CriterionVerdictRow[] | undefined => {
  if (criteria.length === 0 || dimensions.length === 0) return undefined;
  if (criteria.length !== dimensions.length) return undefined;
  const out: CriterionVerdictRow[] = [];
  for (let i = 0; i < criteria.length; i += 1) {
    const c = criteria[i];
    const d = dimensions[i];
    if (c === undefined || d === undefined) return undefined;
    out.push({ criterion: c, passed: d.passed });
  }
  return out;
};

export const EvaluationLine = ({
  evaluation,
  criteria,
}: {
  readonly evaluation: EvaluationSignal;
  readonly criteria?: readonly string[];
}): React.JSX.Element => {
  const color =
    evaluation.status === 'passed'
      ? inkColors.success
      : evaluation.status === 'failed'
        ? inkColors.error
        : inkColors.warning;
  const fused = criteria !== undefined ? fuseCriteriaWithDimensions(criteria, evaluation.dimensions) : undefined;
  return (
    <Box flexDirection="column">
      <Box>
        <Text dimColor>{fmtIsoTime(String(evaluation.timestamp))}</Text>
        <Text color={color} bold>
          {'  '}eval{'  '}
        </Text>
        <Text bold>{evaluation.status}</Text>
      </Box>
      {fused !== undefined ? (
        // Per-criterion attribution: one row per criterion, each ellided on width so a long
        // criterion line never explodes the layout. Pass / fail glyph at the head matches the
        // paired dimension's `passed` flag.
        <Box flexDirection="column" paddingLeft={6}>
          {fused.map((row, i) => (
            <Box key={`crit-${String(i)}`}>
              <Text color={row.passed ? inkColors.success : inkColors.error} bold>
                {row.passed ? glyphs.check : glyphs.cross}
              </Text>
              <Text> </Text>
              <Box flexGrow={1} flexShrink={1}>
                <Text wrap="truncate-end">{collapseWhitespace(row.criterion)}</Text>
              </Box>
            </Box>
          ))}
        </Box>
      ) : (
        evaluation.dimensions.length > 0 && (
          <Box paddingLeft={6}>
            <Text dimColor>
              {evaluation.dimensions
                .map((d) => `${d.dimension}: ${d.passed ? glyphs.check : glyphs.cross}`)
                .join(`  ${glyphs.bullet}  `)}
            </Text>
          </Box>
        )
      )}
    </Box>
  );
};
