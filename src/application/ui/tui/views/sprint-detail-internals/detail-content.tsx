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
import type { Project } from '@src/domain/entity/project.ts';
import type { Ticket } from '@src/domain/entity/ticket.ts';
import { SprintHeaderStrip } from '@src/application/ui/tui/components/sprint-header-strip.tsx';
import { snapshotFromLoadedSprint } from '@src/application/ui/shared/state-snapshot.ts';
import { OutcomeReportCard } from '@src/application/ui/tui/views/sprint-detail-internals/outcome-card.tsx';
import { TicketsSection } from '@src/application/ui/tui/views/sprint-detail-internals/ticket-list.tsx';
import { TasksSection } from '@src/application/ui/tui/views/sprint-detail-internals/task-summary.tsx';
import { ActionBar } from '@src/application/ui/tui/views/sprint-detail-internals/action-bar.tsx';
import type { FocusItem } from '@src/application/ui/tui/views/sprint-detail-internals/focus-list.ts';
import type { AsyncLoadState } from '@src/application/ui/tui/runtime/use-async-load.ts';
import type { SprintBundle } from '@src/application/ui/tui/views/sprint-detail-internals/use-sprint-bundle.ts';

export interface SprintDetailContentProps {
  readonly state: AsyncLoadState<SprintBundle, unknown>;
  readonly confirmRemove: Ticket | undefined;
  readonly onCancelRemove: () => void;
  readonly onRemoveConfirmed: (target: Ticket, confirmed: boolean) => void;
  readonly confirmPublish: Ticket | undefined;
  readonly onCancelPublish: () => void;
  readonly onPublishConfirmed: (target: Ticket, confirmed: boolean) => void;
  readonly project: Project | undefined;
  readonly focusList: readonly FocusItem[];
  readonly cursorIdx: number;
  readonly openIds: ReadonlySet<string>;
  readonly ticketsEditable: boolean;
}

/**
 * Top-level render branch: load/error states > remove confirm > the loaded
 * body. Flat if-returns instead of a nested ternary chain — same branch order and same props
 * as before, just laid out as one branch per line.
 */
export const SprintDetailContent = ({
  state,
  confirmRemove,
  onCancelRemove,
  onRemoveConfirmed,
  confirmPublish,
  onCancelPublish,
  onPublishConfirmed,
  project,
  focusList,
  cursorIdx,
  openIds,
  ticketsEditable,
}: SprintDetailContentProps): React.JSX.Element => {
  if (state.kind === 'loading' || state.kind === 'idle') return <LoadingRow label="Loading…" />;
  if (state.kind === 'error') return <LoadErrorRow message="Failed to load sprint." />;
  if (confirmRemove !== undefined) {
    return (
      <ConfirmCard
        verb="Remove"
        target={
          <>
            ticket <Text bold>{confirmRemove.title}</Text> from this sprint
          </>
        }
        onSubmit={(value) => onRemoveConfirmed(confirmRemove, value)}
        onCancel={onCancelRemove}
      />
    );
  }
  if (confirmPublish !== undefined) {
    const destination =
      confirmPublish.link !== undefined
        ? `Posts the refined requirements as a comment on ${confirmPublish.link}.`
        : `Creates a new issue on ${project !== undefined ? `${project.displayName}'s` : "the repository's"} origin tracker.`;
    return (
      <ConfirmCard
        verb="Publish"
        target={
          <>
            ticket <Text bold>{confirmPublish.title}</Text> to the issue tracker
          </>
        }
        body={<Text dimColor>{destination} This is visible to others and cannot be unsent.</Text>}
        onSubmit={(value) => onPublishConfirmed(confirmPublish, value)}
        onCancel={onCancelPublish}
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
}

const Body = ({ bundle, project, focusList, cursorIdx, openIds, ticketsEditable }: BodyProps): React.JSX.Element => {
  const { sprint, tasks } = bundle;
  return (
    <Box flexDirection="column">
      <SprintHeaderStrip snapshot={snapshotFromLoadedSprint({ project, sprint, tasks })} variant="detail" />
      {(sprint.status === 'review' || sprint.status === 'done') && <OutcomeReportCard sprint={sprint} tasks={tasks} />}
      <TicketsSection
        sprint={sprint}
        tasks={tasks}
        focusList={focusList}
        cursorIdx={cursorIdx}
        ticketsEditable={ticketsEditable}
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
