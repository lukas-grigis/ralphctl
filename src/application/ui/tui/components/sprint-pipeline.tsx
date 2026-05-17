/**
 * Single-line stage tracker — `Refine ▶ Plan ▶ Implement ▶ Review ▶ Done`. The current stage
 * renders in the primary accent; everything else is dimmed. Designed to live above the flow
 * menu so the user has a constant "where am I in the sprint lifecycle?" anchor.
 *
 * Stage resolution from {@link AppStateSnapshot}:
 *
 *   - No sprint                                → no pipeline (render `null`).
 *   - sprint.status === 'draft' + pending tix  → Refine
 *   - sprint.status === 'draft', no pending    → Plan (refinement complete; ready to plan)
 *   - sprint.status === 'planned'              → Implement (plan complete; ready to run)
 *   - sprint.status === 'active'               → Implement (running)
 *   - sprint.status === 'review'               → Review
 *   - sprint.status === 'done'                 → Done
 */

import React from 'react';
import { Box, Text } from 'ink';
import { glyphs, inkColors, spacing } from '@src/application/ui/tui/theme/tokens.ts';
import type { AppStateSnapshot } from '@src/application/ui/shared/state-snapshot.ts';

const STAGES = ['Refine', 'Plan', 'Implement', 'Review', 'Done'] as const;
type Stage = (typeof STAGES)[number];

export const resolveSprintStage = (snapshot: AppStateSnapshot): Stage | undefined => {
  const sprint = snapshot.sprint;
  if (sprint === undefined) return undefined;
  switch (sprint.status) {
    case 'draft':
      return snapshot.triggerInputs.pendingTicketCount > 0 ? 'Refine' : 'Plan';
    case 'planned':
    case 'active':
      return 'Implement';
    case 'review':
      return 'Review';
    case 'done':
      return 'Done';
  }
};

export interface SprintPipelineProps {
  readonly snapshot: AppStateSnapshot;
}

export const SprintPipeline = ({ snapshot }: SprintPipelineProps): React.JSX.Element | null => {
  const stage = resolveSprintStage(snapshot);
  if (stage === undefined) return null;
  return (
    <Box paddingX={spacing.indent}>
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
