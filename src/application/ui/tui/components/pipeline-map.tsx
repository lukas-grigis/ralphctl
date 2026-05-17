/**
 * Pipeline map — the home spine. A horizontal bar of phases (Refine → Plan → Implement → Close)
 * with a state glyph per phase. Reflects the current sprint's status; when no sprint exists,
 * every phase is dimmed with `Refine` as the next available step.
 *
 * The phase ordering is intentionally fixed — the harness always flows in this direction. A
 * future sprint that's already planned shows Refine as ✓, Plan as ✓, Implement as the next
 * actionable step, and Close as pending.
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { SprintStatus } from '@src/domain/entity/sprint.ts';
import { glyphs, inkColors, spacing } from '@src/application/ui/tui/theme/tokens.ts';

export type PhaseId = 'refine' | 'plan' | 'implement' | 'close';

export interface PipelinePhase {
  readonly id: PhaseId;
  readonly label: string;
}

export const phases: readonly PipelinePhase[] = [
  { id: 'refine', label: 'Refine' },
  { id: 'plan', label: 'Plan' },
  { id: 'implement', label: 'Implement' },
  { id: 'close', label: 'Close' },
];

type PhaseState = 'done' | 'active' | 'pending' | 'disabled';

const phaseStateFor = (id: PhaseId, status: SprintStatus | undefined): PhaseState => {
  if (status === undefined) return id === 'refine' ? 'active' : 'disabled';
  switch (status) {
    case 'draft':
      return id === 'refine' ? 'active' : 'pending';
    case 'planned':
      if (id === 'refine' || id === 'plan') return 'done';
      if (id === 'implement') return 'active';
      return 'pending';
    case 'active':
      if (id === 'refine' || id === 'plan') return 'done';
      if (id === 'implement') return 'active';
      return 'pending';
    case 'review':
      if (id === 'refine' || id === 'plan' || id === 'implement') return 'done';
      return 'active';
    case 'done':
      return 'done';
    default:
      return 'pending';
  }
};

const stateGlyph = (state: PhaseState): string => {
  switch (state) {
    case 'done':
      return glyphs.phaseDone;
    case 'active':
      return glyphs.phaseActive;
    case 'pending':
      return glyphs.phasePending;
    case 'disabled':
      return glyphs.phaseDisabled;
  }
};

const stateColor = (state: PhaseState): string => {
  switch (state) {
    case 'done':
      return inkColors.success;
    case 'active':
      return inkColors.highlight;
    case 'pending':
      return inkColors.muted;
    case 'disabled':
      return inkColors.muted;
  }
};

export interface PipelineMapProps {
  readonly status: SprintStatus | undefined;
}

export const PipelineMap = ({ status }: PipelineMapProps): React.JSX.Element => (
  <Box paddingX={spacing.indent}>
    {phases.map((phase, idx) => {
      const state = phaseStateFor(phase.id, status);
      const color = stateColor(state);
      return (
        <Box key={phase.id}>
          <Text color={color} bold={state === 'active'}>
            {stateGlyph(state)} {phase.label}
          </Text>
          {idx < phases.length - 1 && <Text dimColor> {glyphs.arrowRight} </Text>}
        </Box>
      );
    })}
  </Box>
);
