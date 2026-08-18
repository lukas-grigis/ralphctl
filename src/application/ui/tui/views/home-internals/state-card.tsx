/**
 * Home view's main hero card. Three regimes pick the layout:
 *   - no project           → big empty state with "create your first project" CTA
 *   - project, no sprint   → ready-to-start-a-sprint card with a single prominent CTA
 *   - project + sprint     → sprint-centric overview: name + status + counts + pipeline
 *
 * The point: when the user lands on home, the most relevant action should be the visual focus.
 * A dense FieldList of project / repo / ticket metadata buries that action.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { Card } from '@src/application/ui/tui/components/card.tsx';
import { sprintStatusKind, StatusChip } from '@src/application/ui/tui/components/status-chip.tsx';
import { PipelineMap } from '@src/application/ui/tui/components/pipeline-map.tsx';
import { Spinner } from '@src/application/ui/tui/components/spinner.tsx';
import { glyphs, inkColors, spacing } from '@src/application/ui/tui/theme/tokens.ts';
import type { AppStateSnapshot } from '@src/application/ui/shared/state-snapshot.ts';
import { buildNextSteps, nextStepsInputFromSnapshot } from '@src/application/ui/shared/next-steps.ts';
import { NextStepList } from '@src/application/ui/tui/components/next-steps.tsx';

/**
 * A short instruction line: "press <KEY> to <do thing>". Renders the key in highlight, the
 * label in plain text. Used by every regime of StateCard to make the next action obvious.
 */
const KeyCue = ({ keys, label }: { readonly keys: string; readonly label: string }): React.JSX.Element => (
  <Text>
    <Text dimColor>{glyphs.bullet} press </Text>
    <Text bold color={inkColors.highlight}>
      {keys}
    </Text>
    <Text dimColor> to </Text>
    <Text>{label}</Text>
  </Text>
);

/**
 * A one-liner explaining how the app is laid out — visible only when the user hasn't yet
 * created a sprint. Once they're in the flow it stays out of the way.
 */
const OrientationLine = (): React.JSX.Element => (
  <Box marginTop={spacing.section}>
    <Text dimColor italic>
      Workflow: project {glyphs.arrowRight} sprint {glyphs.arrowRight} tickets {glyphs.arrowRight} refine{' '}
      {glyphs.arrowRight} plan {glyphs.arrowRight} implement {glyphs.arrowRight} PR
    </Text>
  </Box>
);

/*
 * NOTE — the three empty-state heroes below (NoProjectCard / PickProjectCard /
 * PickOrCreateSprintCard) keep their own big CTAs rather than rendering `buildNextSteps`'
 * pre-sprint rows. Those rows exist so the settled-run and Flows surfaces have something to say
 * in the same states; here a full-width hero with one prominent action already does that job
 * better. Do not "unify" these into one-line hints — that would be a regression, not a cleanup.
 */

/** Regime: no project exists yet anywhere in storage. */
const NoProjectCard = (): React.JSX.Element => (
  <Card title={`${glyphs.actionCursor} Start by creating a project`} tone="primary">
    <Box flexDirection="column" paddingX={spacing.indent}>
      <Text>A project binds one or more repositories together. Sprints, tickets, and runs all live inside one.</Text>
      <Box marginTop={spacing.section}>
        <KeyCue keys="c" label="create your first project" />
      </Box>
      <OrientationLine />
    </Box>
  </Card>
);

/** Regime: projects exist, but none is the current selection. */
const PickProjectCard = ({ projectCount }: { readonly projectCount: number }): React.JSX.Element => (
  <Card title={`${glyphs.actionCursor} Pick a project to work on`} tone="primary">
    <Box flexDirection="column" paddingX={spacing.indent}>
      <Text>
        <Text bold>{String(projectCount)}</Text>
        <Text dimColor> project{projectCount === 1 ? '' : 's'} in storage.</Text>
      </Text>
      <Box marginTop={spacing.section}>
        <KeyCue keys="p" label="open Projects and select one" />
      </Box>
    </Box>
  </Card>
);

/** Regime: a project is selected, but no sprint is loaded yet. */
const PickOrCreateSprintCard = ({
  projectName,
  sprintCount,
}: {
  readonly projectName: string;
  readonly sprintCount: number;
}): React.JSX.Element => {
  const title = `${glyphs.actionCursor} ${projectName} — ${sprintCount === 0 ? 'ready for the first sprint' : 'pick or create a sprint'}`;
  return (
    <Card title={title} tone="primary">
      <Box flexDirection="column" paddingX={spacing.indent}>
        {sprintCount === 0 ? (
          <Text>Sprints are the unit of work. Refine, plan, and implement all target one.</Text>
        ) : (
          <Text>
            <Text bold>{String(sprintCount)}</Text>
            <Text dimColor> sprint{sprintCount === 1 ? '' : 's'} in this project — pick one to continue.</Text>
          </Text>
        )}
        <Box marginTop={spacing.section}>
          <KeyCue
            keys="r"
            label={sprintCount === 0 ? 'open Sprints and press c to create one' : 'open Sprints to pick or create one'}
          />
        </Box>
        {sprintCount === 0 && <OrientationLine />}
      </Box>
    </Card>
  );
};

/** Regime: a sprint is loaded — the main overview with counts + pipeline + next action. */
const ActiveSprintCard = ({ state }: { readonly state: AppStateSnapshot }): React.JSX.Element => {
  const sprint = state.sprint;
  const project = state.project;
  if (sprint === undefined || project === undefined) return <Box />;
  // One shared table for Home, Flows, and the settled ResultCard — and it is checked against the
  // flow menu's own visibility rules, so `review` no longer points at create-pr (hidden there).
  const { steps } = buildNextSteps(nextStepsInputFromSnapshot(state));
  return (
    <Card
      title={`${glyphs.actionCursor} ${sprint.name}`}
      tone="primary"
      right={<StatusChip label={sprint.status} kind={sprintStatusKind(sprint.status)} />}
    >
      <Box flexDirection="column" paddingX={spacing.indent}>
        <Box>
          <Text dimColor>
            {project.displayName} {glyphs.bullet} {String(project.repositories.length)} repo
            {project.repositories.length === 1 ? '' : 's'}
          </Text>
        </Box>
        <Box marginTop={spacing.section}>
          <Text>
            <Text bold>{String(sprint.tickets.length)}</Text>
            <Text dimColor> tickets </Text>
            <Text bold color={inkColors.warning}>
              {String(state.triggerInputs.pendingTicketCount)}
            </Text>
            <Text dimColor> pending </Text>
            <Text bold color={inkColors.success}>
              {String(state.triggerInputs.approvedTicketCount)}
            </Text>
            <Text dimColor> approved {glyphs.bullet} </Text>
            <Text bold>{String(state.triggerInputs.resumableTaskCount)}</Text>
            <Text dimColor> tasks pending</Text>
          </Text>
        </Box>
        <Box marginTop={spacing.section}>
          <PipelineMap status={sprint.status} />
        </Box>
        <Box marginTop={spacing.section}>
          <NextStepList steps={steps} prefix={`${glyphs.bullet} next: `} />
        </Box>
      </Box>
    </Card>
  );
};

export const StateCard = ({
  state,
  loading,
}: {
  readonly state: AppStateSnapshot | undefined;
  readonly loading: boolean;
}): React.JSX.Element => {
  if (loading) {
    return (
      <Box paddingX={spacing.indent}>
        <Spinner label="loading state…" />
      </Box>
    );
  }
  if (!state) return <Box />;
  if (state.projectCount === 0) return <NoProjectCard />;
  if (!state.project) return <PickProjectCard projectCount={state.projectCount} />;
  if (!state.sprint)
    return <PickOrCreateSprintCard projectName={state.project.displayName} sprintCount={state.sprintCount} />;
  return <ActiveSprintCard state={state} />;
};
