/**
 * EvaluatorFailurePanel — per-dimension verdict view rendered when an attempt's evaluator
 * verdict is `failed`. Surfaces the same data the canonical 4-line dimension summary shows,
 * but with each dimension colour-coded by pass/fail and the critique excerpt one keystroke
 * away from the full body.
 *
 * Gating: the panel only renders when `settings.developer.showEvaluatorFailureUI === true`.
 * Until promoted, production keeps the current single-line dimension summary that already
 * lives in `tasks-panel.tsx`. The dev flag is the safety valve while the UI is validated
 * against real-world evaluator output.
 *
 * Layout:
 *
 *   eval failed   3.0/5.0
 *     correctness: 5/5 ✓
 *     completeness: 2/5 ✗
 *     style: 4/5 ✓
 *     tests: 1/5 ✗
 *   ▸ critique: lorem ipsum dolor sit amet… (press d to expand)
 *   ↳ next round will receive this critique
 *
 * Press `d` while the panel is focused to expand / collapse the critique body. Expansion
 * state lives in panel-local `useState` so it persists across re-renders within the live
 * session but resets when the panel unmounts.
 */

import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { EvaluationSignal } from '@src/domain/signal.ts';
import { glyphs, inkColors } from '@src/application/ui/tui/theme/tokens.ts';
import { fmtIsoTime } from '@src/application/ui/tui/theme/duration.ts';

/**
 * Maximum length of the critique excerpt rendered before the expand affordance. The figure
 * is chosen so a typical 3-sentence critique still fits on one line in an 80-col TUI, with
 * the "press d to expand" hint following on the same row.
 */
const CRITIQUE_EXCERPT_CHARS = 200;

export interface EvaluatorFailurePanelProps {
  /**
   * The failing evaluator signal. The panel still renders when status is `malformed` or
   * `passed` so a misuse at the call site is visible (the colour coding shifts but no
   * dimension is hidden) — gating on `'failed'` is the caller's job.
   */
  readonly evaluation: EvaluationSignal;
  /**
   * `true` when this is NOT the final round of the gen-eval loop — i.e. the harness will
   * feed the critique back into the next generator turn. Drives the "↳ next round will
   * receive this critique" annotation row.
   */
  readonly isFinalRound: boolean;
  /**
   * When `true`, the panel registers a global `useInput` handler so `d` toggles expansion.
   * Defaults `false` so unit tests rendering the panel in isolation don't compete with any
   * other `useInput` consumer in the same Ink tree. The Implement view sets this `true`
   * for the panel attached to the in-flight task's most recent failed evaluation.
   */
  readonly interactive?: boolean;
}

/** Truncate the critique body to {@link CRITIQUE_EXCERPT_CHARS}, appending `…` if needed. */
const excerpt = (text: string): string => {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= CRITIQUE_EXCERPT_CHARS) return collapsed;
  return `${collapsed.slice(0, CRITIQUE_EXCERPT_CHARS).trimEnd()}…`;
};

/** @public */
export const EvaluatorFailurePanel = ({
  evaluation,
  isFinalRound,
  interactive = false,
}: EvaluatorFailurePanelProps): React.JSX.Element => {
  const [expanded, setExpanded] = useState(false);

  // Keyboard expansion — registered only when the caller opted in. The `d` key matches the
  // disclosure-row affordance shown next to the critique excerpt.
  useInput(
    (input) => {
      if (!interactive) return;
      if (input.toLowerCase() === 'd') setExpanded((v) => !v);
    },
    { isActive: interactive }
  );

  const verdictColor =
    evaluation.status === 'failed'
      ? inkColors.error
      : evaluation.status === 'passed'
        ? inkColors.success
        : inkColors.warning;

  const critique = evaluation.critique?.trim() ?? '';
  const hasCritique = critique.length > 0;
  const critiqueExcerpt = hasCritique ? excerpt(critique) : '';
  const isExpandable = hasCritique && critique.length > critiqueExcerpt.length;
  const disclosure = expanded ? glyphs.actionCursor : glyphs.actionCursor;

  return (
    <Box flexDirection="column">
      <Box>
        <Text dimColor>{fmtIsoTime(String(evaluation.timestamp))}</Text>
        <Text color={verdictColor} bold>
          {'  '}eval{'  '}
        </Text>
        <Text bold>{evaluation.status}</Text>
        {evaluation.overallScore !== undefined && (
          <Text dimColor>
            {' '}
            {glyphs.bullet} {evaluation.overallScore.toFixed(1)}/5.0
          </Text>
        )}
      </Box>
      {evaluation.dimensions.length > 0 && (
        <Box flexDirection="column" paddingLeft={4}>
          {evaluation.dimensions.map((d) => {
            const color = d.passed ? inkColors.success : inkColors.error;
            const glyph = d.passed ? glyphs.check : glyphs.cross;
            return (
              <Box key={d.dimension}>
                <Text color={color}>{glyph} </Text>
                <Text>
                  {d.dimension}: {String(d.score)}/5
                </Text>
                {d.finding.length > 0 && (
                  <Text dimColor>
                    {' '}
                    {glyphs.emDash} {d.finding}
                  </Text>
                )}
              </Box>
            );
          })}
        </Box>
      )}
      {hasCritique && !expanded && (
        <Box paddingLeft={2}>
          <Text dimColor>{disclosure} </Text>
          <Text>critique: {critiqueExcerpt}</Text>
          {isExpandable && <Text dimColor> (press d to expand)</Text>}
        </Box>
      )}
      {hasCritique && expanded && (
        <Box flexDirection="column" paddingLeft={2}>
          <Box>
            <Text dimColor>{disclosure} </Text>
            <Text bold>critique</Text>
            {isExpandable && <Text dimColor> (press d to collapse)</Text>}
          </Box>
          <Box paddingLeft={2}>
            <Text>{critique}</Text>
          </Box>
        </Box>
      )}
      {!isFinalRound && (
        <Box paddingLeft={2}>
          <Text dimColor>{glyphs.activityArrow} next round will receive this critique</Text>
        </Box>
      )}
    </Box>
  );
};
