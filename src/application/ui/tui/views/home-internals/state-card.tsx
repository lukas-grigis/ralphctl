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
  <Box marginTop={1}>
    <Text dimColor italic>
      Workflow: project {glyphs.arrowRight} sprint {glyphs.arrowRight} tickets {glyphs.arrowRight} refine{' '}
      {glyphs.arrowRight} plan {glyphs.arrowRight} implement {glyphs.arrowRight} PR
    </Text>
  </Box>
);

/**
 * Phase-aware "next action" hint for a loaded sprint — mirrors the one on sprint-detail so
 * the user sees the same recommendation regardless of where they look.
 */
const sprintNextActionLabel = (snapshot: AppStateSnapshot): string | undefined => {
  const sprint = snapshot.sprint;
  if (sprint === undefined) return undefined;
  const { pendingTicketCount, approvedTicketCount, resumableTaskCount } = snapshot.triggerInputs;
  switch (sprint.status) {
    case 'draft':
      if (sprint.tickets.length === 0) return 'add tickets — open the sprint and press a';
      if (pendingTicketCount > 0) return `refine ${String(pendingTicketCount)} pending ticket(s) — press n`;
      if (approvedTicketCount > 0) return `plan ${String(approvedTicketCount)} approved ticket(s) — press n`;
      return undefined;
    case 'planned':
    case 'active':
      if (resumableTaskCount > 0) return `implement ${String(resumableTaskCount)} pending task(s) — press n`;
      return 'review the sprint — open it for the task list';
    case 'review':
      return 'open a pull request — press n → create-pr';
    case 'done':
      return undefined;
  }
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

  if (state.projectCount === 0) {
    return (
      <Card title="▸ Start by creating a project" tone="primary">
        <Box flexDirection="column" paddingX={spacing.indent}>
          <Text>
            A project binds one or more repositories together. Sprints, tickets, and runs all live inside one.
          </Text>
          <Box marginTop={1}>
            <KeyCue keys="c" label="create your first project" />
          </Box>
          <OrientationLine />
        </Box>
      </Card>
    );
  }

  if (!state.project) {
    return (
      <Card title="▸ Pick a project to work on" tone="primary">
        <Box flexDirection="column" paddingX={spacing.indent}>
          <Text>
            <Text bold>{String(state.projectCount)}</Text>
            <Text dimColor> project{state.projectCount === 1 ? '' : 's'} in storage.</Text>
          </Text>
          <Box marginTop={1}>
            <KeyCue keys="p" label="open Projects and select one" />
          </Box>
        </Box>
      </Card>
    );
  }

  const sprint = state.sprint;
  const sprintCount = state.sprintCount;

  if (!sprint) {
    const title = `▸ ${state.project.displayName} — ${sprintCount === 0 ? 'ready for the first sprint' : 'pick or create a sprint'}`;
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
          <Box marginTop={1}>
            <KeyCue
              keys="r"
              label={
                sprintCount === 0 ? 'open Sprints and press c to create one' : 'open Sprints to pick or create one'
              }
            />
          </Box>
          {sprintCount === 0 && <OrientationLine />}
        </Box>
      </Card>
    );
  }

  const nextAction = sprintNextActionLabel(state);
  return (
    <Card
      title={`▸ ${sprint.name}`}
      tone="primary"
      right={<StatusChip label={sprint.status} kind={sprintStatusKind(sprint.status)} />}
    >
      <Box flexDirection="column" paddingX={spacing.indent}>
        <Box>
          <Text dimColor>
            {state.project.displayName} {glyphs.bullet} {String(state.project.repositories.length)} repo
            {state.project.repositories.length === 1 ? '' : 's'}
          </Text>
        </Box>
        <Box marginTop={1}>
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
        <Box marginTop={1}>
          <PipelineMap status={sprint.status} />
        </Box>
        {nextAction !== undefined && (
          <Box marginTop={1}>
            <Text dimColor>{glyphs.bullet} next: </Text>
            <Text bold color={inkColors.highlight}>
              {nextAction}
            </Text>
          </Box>
        )}
      </Box>
    </Card>
  );
};
