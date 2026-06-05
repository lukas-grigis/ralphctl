/**
 * Sprint detail — the sprint workspace.
 *
 * Layout:
 *  - Sprint header (name, status chip, slug, ticket/task counts, phase timeline with elapsed
 *    between sprint state transitions).
 *  - Phase-aware "Next action" card.
 *  - Tickets section (always first) — one bordered Jira-style card per ticket.
 *  - Tasks section — one bordered card per task, showing ticket reference, deps, repo, attempts.
 *
 * Inline expand-in-place: every ticket / task card stays in the list. Pressing ↵/o on the
 * focused card toggles its expansion inline (full description, requirements, referenced tasks
 * for tickets; steps, verification criteria, dependencies, attempt history for tasks) inside
 * the same border. Each card's expansion is tracked independently by stable id, so opening a
 * second card leaves the first one open. Cursor still moves between cards via ↑/↓ / j/k
 * across both sections without changing which cards are expanded. Pressing `esc` / `q` while
 * any card is expanded collapses every expansion in one action.
 *
 * Local keys:
 *   a       add ticket (draft only)
 *   d       remove the focused ticket (draft only) after a confirm
 *   ↑/↓     move the focus cursor across BOTH tickets and tasks
 *   ↵/o     expand / collapse the focused card inline
 *   esc/q   collapse every expanded card (back to list)
 *   n       open Flows, scoped to this sprint
 *
 * This file is the orchestrator — composition + loaders + edit/remove/unblock side effects.
 * Presentational concerns (header card, tickets pane, tasks pane, attempt sub-cards, prose
 * helpers, footer hints, keymap) live in `sprint-detail-internals/`.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text } from 'ink';
import { useEditField } from '@src/application/ui/tui/runtime/use-edit-field.ts';
import { usePromptQueue } from '@src/application/ui/tui/prompts/prompt-context.tsx';
import { ViewShell } from '@src/application/ui/tui/components/view-shell.tsx';
import { Spinner } from '@src/application/ui/tui/components/spinner.tsx';
import { ConfirmPrompt } from '@src/application/ui/tui/prompts/confirm-prompt.tsx';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { Project } from '@src/domain/entity/project.ts';
import type { Task } from '@src/domain/entity/task.ts';
import type { Ticket } from '@src/domain/entity/ticket.ts';
import { spacing } from '@src/application/ui/tui/theme/tokens.ts';
import { useDeps } from '@src/application/ui/tui/runtime/deps-context.tsx';
import { useRouter, useViewProps } from '@src/application/ui/tui/runtime/router.tsx';
import { useUiState } from '@src/application/ui/tui/runtime/ui-state-context.tsx';
import { useViewHints } from '@src/application/ui/tui/runtime/use-view-hints.tsx';
import { HelpOverlay } from '@src/application/ui/tui/components/help-overlay.tsx';
import { useSelection } from '@src/application/ui/tui/runtime/selection-context.tsx';
import { createTicketRemoveFlow } from '@src/application/flows/ticket-remove/flow.ts';
import { unblockTaskUseCase } from '@src/business/task/unblock-task.ts';
import { NextPhaseCard, SprintHeader } from '@src/application/ui/tui/views/sprint-detail-internals/header-card.tsx';
import { TicketsSection } from '@src/application/ui/tui/views/sprint-detail-internals/ticket-list.tsx';
import { TasksSection } from '@src/application/ui/tui/views/sprint-detail-internals/task-summary.tsx';
import { ActionBar } from '@src/application/ui/tui/views/sprint-detail-internals/action-bar.tsx';
import { useSprintDetailShortcuts } from '@src/application/ui/tui/views/sprint-detail-internals/shortcuts.ts';
import { buildFocusList, type FocusItem } from '@src/application/ui/tui/views/sprint-detail-internals/focus-list.ts';
import { runEdit } from '@src/application/ui/tui/views/sprint-detail-internals/field-editors.ts';
import {
  type SprintBundle,
  useSprintBundle,
} from '@src/application/ui/tui/views/sprint-detail-internals/use-sprint-bundle.ts';

interface SprintDetailProps extends Readonly<Record<string, unknown>> {
  readonly sprintId: SprintId;
}

export const SprintDetailView = (): React.JSX.Element => {
  const deps = useDeps();
  const router = useRouter();
  const ui = useUiState();
  const { sprintId } = useViewProps<SprintDetailProps>();
  const selection = useSelection();

  const { state, project, reload } = useSprintBundle({ sprintId, deps });

  // No silent auto-sync of the selection on detail open — opening a sprint to look at it does
  // NOT make it the current one. The user explicitly presses `m` to mark it current (handler
  // below). This avoids the surprise of a passive browse swapping the active context on every
  // navigation.

  const sprint = state.kind === 'ok' ? state.value.sprint : undefined;
  // Stable identity for the empty-tasks fallback so the downstream `useMemo` doesn't re-fire
  // on every render while loading.
  const tasks = useMemo(() => (state.kind === 'ok' ? state.value.tasks : []), [state]);
  const focusList = useMemo(() => (sprint !== undefined ? buildFocusList(sprint, tasks) : []), [sprint, tasks]);

  const [cursorIdx, setCursorIdx] = useState(0);
  const [openIds, setOpenIds] = useState<ReadonlySet<string>>(() => new Set());
  const [confirmRemove, setConfirmRemove] = useState<Ticket | undefined>(undefined);
  const [feedback, setFeedback] = useState<string | undefined>(undefined);

  // Ticket CRUD is only meaningful in draft. Detail-mode disables hot keys other than esc.
  const ticketsEditable = sprint?.status === 'draft';
  const inDetail = openIds.size > 0;
  const focusedNow = focusList[Math.min(cursorIdx, Math.max(0, focusList.length - 1))];
  // "Stuck" covers both `blocked` (maxAttempts exhausted / verify failed) and `in_progress`
  // with a settled last attempt (crash recovery after Ctrl-C / watchdog kill). Both map to the
  // same operator action: press `u` to reset to `todo` and retry on the next implement run.
  const focusedStuckTask =
    focusedNow?.kind === 'task' && (focusedNow.task.status === 'blocked' || focusedNow.task.status === 'in_progress')
      ? focusedNow.task
      : undefined;

  const edit = useEditField();
  const queue = usePromptQueue();

  const focusedTicket = focusedNow?.kind === 'ticket' && ticketsEditable ? focusedNow.ticket : undefined;
  const focusedTodoTask =
    focusedNow?.kind === 'task' && focusedNow.task.status === 'todo' ? focusedNow.task : undefined;
  const canEdit = focusedTicket !== undefined || focusedTodoTask !== undefined;

  // Every hint shares one source of truth with its handler via `enabledWhen`: the `a`/`d`
  // ticket-CRUD chords are gated on `ticketsEditable` (draft only), so the hints must hide on a
  // non-draft sprint or the footer would advertise keys that do nothing. `m` (mark-current) and
  // `u` (unblock) follow the same declarative gate rather than conditional spreads.
  useViewHints([
    { keys: 'n', label: 'flows' },
    { keys: '↵/o', label: inDetail ? 'expand/collapse' : 'expand' },
    { keys: 'a', label: 'add ticket', enabledWhen: ticketsEditable === true },
    { keys: 'e', label: 'edit field', enabledWhen: canEdit },
    { keys: 'd', label: 'remove ticket', enabledWhen: ticketsEditable === true },
    // Surface the `m` chord only when this sprint is not already the current one — once
    // they match, the action is a no-op and the hint adds noise. Suppressed while a
    // stuck task is focused so the `u unblock` hint (a more urgent operator action)
    // stays prominent in the footer without competing for horizontal space.
    {
      keys: 'm',
      label: 'current',
      enabledWhen: sprint !== undefined && selection.sprintId !== sprint.id && focusedStuckTask === undefined,
    },
    { keys: 'u', label: 'unblock', enabledWhen: focusedStuckTask !== undefined },
  ]);

  const handleEdit = (): void => {
    if (sprint === undefined) return;
    runEdit({
      sprint,
      focusedTicket,
      focusedTodoTask,
      queue,
      sprintRepo: deps.sprintRepo,
      taskRepo: deps.taskRepo,
      reload,
      openEditPrompt: edit.openEditPrompt,
    });
  };

  const handleUnblock = async (target: Task): Promise<void> => {
    if (sprint === undefined) return;
    const r = await unblockTaskUseCase({
      task: target,
      sprintId: sprint.id,
      taskRepo: deps.taskRepo,
      sprintRepo: deps.sprintRepo,
      clock: deps.clock,
      logger: deps.logger,
    });
    if (!r.ok) {
      setFeedback(`✗ ${r.error.message}`);
      return;
    }
    setFeedback(`✓ unblocked "${target.name}"`);
    reload();
  };

  useSprintDetailShortcuts({
    helpOpen: ui.helpOpen,
    promptActive: ui.promptActive,
    confirmRemoveActive: confirmRemove !== undefined,
    sprint,
    inDetail,
    ticketsEditable: ticketsEditable === true,
    canEdit,
    isCurrent: sprint !== undefined && selection.sprintId === sprint.id,
    focusList,
    cursorIdx,
    focusedStuckTask,
    closeAllExpanded: () => setOpenIds(new Set()),
    openAddTicket: (id) => router.push({ id: 'add-ticket', props: { sprintId: id } }),
    toggleExpand: (id) =>
      setOpenIds((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      }),
    moveCursor: (delta) =>
      setCursorIdx((c) => (delta === 1 ? Math.min(focusList.length - 1, c + 1) : Math.max(0, c - 1))),
    beginRemove: (ticket) => setConfirmRemove(ticket),
    markCurrent: (s) => {
      selection.setSprint(s.id, s.name, s.status);
      setFeedback(`✓ now on ${s.name}`);
    },
    handleEdit,
    handleUnblock: (task) => {
      void handleUnblock(task);
    },
  });

  // Mute global keys while the confirm prompt is mounted.
  const claimPrompt = ui.claimPrompt;
  const claimEscape = ui.claimEscape;
  useEffect(() => (confirmRemove !== undefined ? claimPrompt() : undefined), [confirmRemove, claimPrompt]);

  // Claim `esc` while the detail card is open so the local handler can close the card without
  // the global `router.pop()` racing it and dumping the user back to the Sprints list.
  useEffect(() => (inDetail ? claimEscape() : undefined), [inDetail, claimEscape]);

  const handleRemoveConfirmed = async (target: Ticket, confirmed: boolean): Promise<void> => {
    setConfirmRemove(undefined);
    if (!confirmed || sprint === undefined) return;
    const flow = createTicketRemoveFlow({ sprintRepo: deps.sprintRepo });
    const r = await flow.execute({ input: { sprintId: sprint.id, ticketId: target.id } });
    if (!r.ok) {
      setFeedback(`✗ ${r.error.error.message}`);
      return;
    }
    setFeedback(`✓ removed "${target.title}"`);
    reload();
  };

  return (
    <ViewShell
      title="Sprint"
      subtitle={state.kind === 'ok' ? state.value.sprint.name : 'loading'}
      // The ticket + task panes own the focus cursor (↑/↓ / j/k drive the windowed lists), so the
      // page ScrollRegion must NOT also consume arrows once the list is visible — otherwise both
      // would move on a single keypress. During loading / error the list isn't mounted, so the
      // page scroll keeps its arrows there.
      suppressScrollArrows={state.kind === 'ok'}
    >
      {ui.helpOpen ? (
        <HelpOverlay />
      ) : state.kind === 'loading' || state.kind === 'idle' ? (
        <Box paddingX={spacing.indent}>
          <Spinner label="Loading…" />
        </Box>
      ) : state.kind === 'error' ? (
        <Box paddingX={spacing.indent}>
          <Text>Failed to load sprint.</Text>
        </Box>
      ) : confirmRemove !== undefined ? (
        <Box flexDirection="column" paddingX={spacing.indent}>
          <Text>
            Remove ticket <Text bold>{confirmRemove.title}</Text> from this sprint?
          </Text>
          <Box marginTop={1}>
            <ConfirmPrompt
              message="Remove?"
              defaultYes={false}
              onSubmit={(value) => void handleRemoveConfirmed(confirmRemove, value)}
              onCancel={() => setConfirmRemove(undefined)}
            />
          </Box>
        </Box>
      ) : (
        <Body
          bundle={state.value}
          project={project}
          focusList={focusList}
          cursorIdx={Math.min(cursorIdx, Math.max(0, focusList.length - 1))}
          openIds={openIds}
          ticketsEditable={ticketsEditable === true}
          feedback={feedback ?? edit.feedback}
          isCurrent={selection.sprintId === state.value.sprint.id}
        />
      )}
    </ViewShell>
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
