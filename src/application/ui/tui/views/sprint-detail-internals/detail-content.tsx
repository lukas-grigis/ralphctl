/**
 * Sprint detail — presentational render branch.
 *
 * `SprintDetailContent` is the top-level branch (help overlay > load/error states > remove
 * confirm > the loaded body) and `Body` is the loaded-state layout. Both are pure render —
 * every prop is handed down from `useSprintDetailBody` in `detail-body.tsx`.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { LoadErrorRow, LoadingRow } from '@src/application/ui/tui/components/async-rows.tsx';
import { ConfirmCard } from '@src/application/ui/tui/components/confirm-card.tsx';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { Project } from '@src/domain/entity/project.ts';
import type { Ticket } from '@src/domain/entity/ticket.ts';
import { HelpOverlay } from '@src/application/ui/tui/components/help-overlay.tsx';
import { NextPhaseCard, SprintHeader } from '@src/application/ui/tui/views/sprint-detail-internals/header-card.tsx';
import { TicketsSection } from '@src/application/ui/tui/views/sprint-detail-internals/ticket-list.tsx';
import { TasksSection } from '@src/application/ui/tui/views/sprint-detail-internals/task-summary.tsx';
import { ActionBar } from '@src/application/ui/tui/views/sprint-detail-internals/action-bar.tsx';
import type { FocusItem } from '@src/application/ui/tui/views/sprint-detail-internals/focus-list.ts';
import type { AsyncLoadState } from '@src/application/ui/tui/runtime/use-async-load.ts';
import type { SprintBundle } from '@src/application/ui/tui/views/sprint-detail-internals/use-sprint-bundle.ts';

export interface SprintDetailContentProps {
  readonly helpOpen: boolean;
  readonly state: AsyncLoadState<SprintBundle, unknown>;
  readonly confirmRemove: Ticket | undefined;
  readonly onCancelRemove: () => void;
  readonly onRemoveConfirmed: (target: Ticket, confirmed: boolean) => void;
  readonly project: Project | undefined;
  readonly focusList: readonly FocusItem[];
  readonly cursorIdx: number;
  readonly openIds: ReadonlySet<string>;
  readonly ticketsEditable: boolean;
  readonly feedback: string | undefined;
  readonly currentSprintId: SprintId | undefined;
}

/**
 * Top-level render branch: help overlay > load/error states > remove confirm > the loaded
 * body. Flat if-returns instead of a nested ternary chain — same branch order and same props
 * as before, just laid out as one branch per line.
 */
export const SprintDetailContent = ({
  helpOpen,
  state,
  confirmRemove,
  onCancelRemove,
  onRemoveConfirmed,
  project,
  focusList,
  cursorIdx,
  openIds,
  ticketsEditable,
  feedback,
  currentSprintId,
}: SprintDetailContentProps): React.JSX.Element => {
  if (helpOpen) return <HelpOverlay />;
  if (state.kind === 'loading' || state.kind === 'idle') return <LoadingRow label="Loading…" />;
  if (state.kind === 'error') return <LoadErrorRow message="Failed to load sprint." />;
  if (confirmRemove !== undefined) {
    return (
      <ConfirmCard
        title={
          <Text>
            Remove ticket <Text bold>{confirmRemove.title}</Text> from this sprint?
          </Text>
        }
        message="Remove?"
        onSubmit={(value) => onRemoveConfirmed(confirmRemove, value)}
        onCancel={onCancelRemove}
      />
    );
  }
  return (
    <Body
      bundle={state.value}
      project={project}
      focusList={focusList}
      cursorIdx={Math.min(cursorIdx, Math.max(0, focusList.length - 1))}
      openIds={openIds}
      ticketsEditable={ticketsEditable}
      feedback={feedback}
      isCurrent={currentSprintId === state.value.sprint.id}
    />
  );
};

interface BodyProps {
  readonly bundle: SprintBundle;
  readonly project: Project | undefined;
  readonly focusList: readonly FocusItem[];
  readonly cursorIdx: number;
  readonly openIds: ReadonlySet<string>;
  readonly ticketsEditable: boolean;
  readonly feedback: string | undefined;
  readonly isCurrent: boolean;
}

const Body = ({
  bundle,
  project,
  focusList,
  cursorIdx,
  openIds,
  ticketsEditable,
  feedback,
  isCurrent,
}: BodyProps): React.JSX.Element => {
  const { sprint, tasks } = bundle;
  return (
    <Box flexDirection="column">
      <SprintHeader sprint={sprint} tasks={tasks} isCurrent={isCurrent} />
      <NextPhaseCard sprint={sprint} tasks={tasks} />
      <TicketsSection
        sprint={sprint}
        tasks={tasks}
        focusList={focusList}
        cursorIdx={cursorIdx}
        ticketsEditable={ticketsEditable}
        feedback={feedback}
        openIds={openIds}
      />
      <TasksSection
        sprint={sprint}
        tasks={tasks}
        focusList={focusList}
        cursorIdx={cursorIdx}
        project={project}
        openIds={openIds}
      />
      <ActionBar />
    </Box>
  );
};
