/**
 * Baseline-Health Chip — single-line companion to the right-context {@link BaselineHealthCard}.
 *
 * Renders above the active-task header so the verify-gate state is visible without scrolling.
 * Four states (colour is the load-bearing signal; glyphs / words are the fallback for
 * monochrome / colour-blind operators):
 *
 *  - `green`   — at least one signal has run and nothing is red / amber.
 *  - `amber`   — broken-baseline attempts OR the latest verify ran long enough ago to be stale.
 *  - `red`     — any regression, any red setup row, or the LATEST pre/post verify row is red.
 *  - `unknown` — initial state; no setup, no verify runs yet.
 *
 * Tier source is {@link synthesiseBaselineHealth} — the same predicate the card consumes, so
 * chip and card cannot disagree.
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { SprintExecution } from '@src/domain/entity/sprint-execution.ts';
import type { Task } from '@src/domain/entity/task.ts';
import { type Tone, tones } from '@src/application/ui/tui/theme/tokens.ts';
import { type BaselineTier, synthesiseBaselineHealth } from '@src/application/ui/tui/components/baseline-health.ts';

const TIER_TONE: Readonly<Record<BaselineTier, Tone>> = {
  green: 'success',
  amber: 'warning',
  red: 'error',
  unknown: 'muted',
};

/** @public */
export interface BaselineHealthChipProps {
  readonly execution?: SprintExecution;
  readonly tasks?: readonly Task[];
  readonly now?: number;
}

export const BaselineHealthChip = ({ execution, tasks, now }: BaselineHealthChipProps): React.JSX.Element => {
  const summary = synthesiseBaselineHealth({
    ...(execution !== undefined ? { execution } : {}),
    ...(tasks !== undefined ? { tasks } : {}),
    now: now ?? Date.now(),
  });
  return (
    <Box>
      <Text dimColor>baseline </Text>
      <Text color={tones[TIER_TONE[summary.tier]].color} bold>
        {tones[TIER_TONE[summary.tier]].glyph} {summary.label}
      </Text>
    </Box>
  );
};
