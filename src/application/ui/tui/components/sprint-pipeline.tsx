/**
 * Single-line stage tracker — `Refine → Plan → Implement → Review → Done` — the one pipeline widget every surface
 * renders (Home, Flows, `SprintHeaderStrip`).
 */

import React from 'react';
import { Box, Text } from 'ink';
import { glyphs, inkColors } from '@src/application/ui/tui/theme/tokens.ts';
import type { AppStateSnapshot } from '@src/application/ui/shared/state-snapshot.ts';

/** Stage ids in lifecycle order — the pipeline's only vocabulary. */
const STAGES = ['Refine', 'Plan', 'Implement', 'Review', 'Done'] as const;
type Stage = (typeof STAGES)[number];

export const resolveSprintStage = (snapshot: AppStateSnapshot): Stage | undefined => {
  const sprint = snapshot.sprint;
  if (sprint === undefined) return undefined;
  switch (sprint.status) {
    case 'draft':
      return snapshot.triggerInputs.pendingTicketCount > 0 || sprint.tickets.length === 0 ? 'Refine' : 'Plan';
    case 'planned':
    case 'active':
      return 'Implement';
    case 'review':
      return 'Review';
    case 'done':
      return 'Done';
  }
};

const STAGE_BLURB: Readonly<Record<Stage, string>> = {
  Refine: 'sharpen tickets',
  Plan: 'break into tasks',
  Implement: 'generator + evaluator loop',
  Review: 'evaluator pass',
  Done: 'PR / close',
};

/** The pipeline spelled out, one line per stage — for orientation surfaces with no sprint. */
export const StageLegend = (): React.JSX.Element => (
  <Box flexDirection="column">
    {STAGES.map((s) => (
      <Text key={s}>
        <Text color={inkColors.primary}>{s.padEnd(10)}</Text>
        <Text dimColor>
          {glyphs.emDash} {STAGE_BLURB[s]}
        </Text>
      </Text>
    ))}
  </Box>
);

export interface SprintPipelineProps {
  readonly snapshot: AppStateSnapshot;
}

export const SprintPipeline = ({ snapshot }: SprintPipelineProps): React.JSX.Element | null => {
  const stage = resolveSprintStage(snapshot);
  if (stage === undefined) return null;
  return (
    <Box>
      <Text>
        {STAGES.map((s, i) => {
          const isCurrent = s === stage;
          const isPast = STAGES.indexOf(s) < STAGES.indexOf(stage);
          const color = isCurrent ? inkColors.primary : isPast ? inkColors.success : inkColors.muted;
          return (
            <React.Fragment key={s}>
              <Text color={color} bold={isCurrent}>
                {isCurrent ? `${glyphs.phaseActive} ` : isPast ? `${glyphs.phaseDone} ` : `${glyphs.phasePending} `}
                {s}
              </Text>
              {i < STAGES.length - 1 ? <Text color={inkColors.muted}>{`  ${glyphs.arrowRight}  `}</Text> : null}
            </React.Fragment>
          );
        })}
      </Text>
    </Box>
  );
};
