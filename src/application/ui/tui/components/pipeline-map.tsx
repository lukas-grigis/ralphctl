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

/**
 * Which phases are already `done` and which one is `active` for a given sprint status. Every
 * phase not named in either bucket falls back to `pending`. Reading this table replaces the
 * nested id/status branch cascade that used to live in {@link phaseStateFor}.
 */
const STATUS_PHASE_PROGRESS: Record<
  SprintStatus,
  { readonly done: readonly PhaseId[]; readonly active: PhaseId | undefined }
> = {
  draft: { done: [], active: 'refine' },
  planned: { done: ['refine', 'plan'], active: 'implement' },
  active: { done: ['refine', 'plan'], active: 'implement' },
  review: { done: ['refine', 'plan', 'implement'], active: 'close' },
  done: { done: ['refine', 'plan', 'implement', 'close'], active: undefined },
};

const phaseStateFor = (id: PhaseId, status: SprintStatus | undefined): PhaseState => {
  if (status === undefined) return id === 'refine' ? 'active' : 'disabled';
  const progress = STATUS_PHASE_PROGRESS[status];
  if (progress.done.includes(id)) return 'done';
  if (progress.active === id) return 'active';
  return 'pending';
};

/** Glyph + color pairing for each phase state, read from the shared token tables. */
const STATUS_PRESENTATION: Record<PhaseState, { readonly glyph: string; readonly color: string }> = {
  done: { glyph: glyphs.phaseDone, color: inkColors.success },
  active: { glyph: glyphs.phaseActive, color: inkColors.highlight },
  pending: { glyph: glyphs.phasePending, color: inkColors.muted },
  disabled: { glyph: glyphs.phaseDisabled, color: inkColors.muted },
};

export interface PipelineMapProps {
  readonly status: SprintStatus | undefined;
}

const renderPhase = (phase: PipelinePhase, status: SprintStatus | undefined, isLast: boolean): React.JSX.Element => {
  const state = phaseStateFor(phase.id, status);
  const { glyph, color } = STATUS_PRESENTATION[state];
  return (
    <Box key={phase.id}>
      <Text color={color} bold={state === 'active'}>
        {glyph} {phase.label}
      </Text>
      {!isLast && <Text dimColor> {glyphs.arrowRight} </Text>}
    </Box>
  );
};

export const PipelineMap = ({ status }: PipelineMapProps): React.JSX.Element => (
  <Box paddingX={spacing.indent}>
    {phases.map((phase, idx) => renderPhase(phase, status, idx === phases.length - 1))}
  </Box>
);
