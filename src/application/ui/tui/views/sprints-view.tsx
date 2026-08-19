/**
 * Sprints list — every sprint, scoped to the current project when one is selected. Selecting
 * a row sets it as the current sprint and pushes its detail view.
 *
 * Local keys:
 *   c   launch the create-sprint flow against the current project.
 *   e   rename the focused sprint (inert on a done sprint, which is immutable).
 *   d   confirm + remove the focused sprint (cascades execution + tasks via sprintRepo.remove).
 *   r   reload the list.
 *   u   bulk-unblock the focused sprint's stuck tasks.
 *   ↵   open the sprint's detail view.
 */

import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { ViewShell } from '@src/application/ui/tui/components/view-shell.tsx';
import {
  OverflowRow,
  useListWindow,
  type UseListWindowResult,
} from '@src/application/ui/tui/components/windowed-list.tsx';
import { AsyncListFrame } from '@src/application/ui/tui/components/async-list-frame.tsx';
import { EmptyState } from '@src/application/ui/tui/components/empty-state.tsx';
import { FeedbackLine } from '@src/application/ui/tui/components/feedback-line.tsx';
import { sprintStatusKind, StatusChip } from '@src/application/ui/tui/components/status-chip.tsx';
import { ConfirmCard } from '@src/application/ui/tui/components/confirm-card.tsx';
import { renameSprint, type Sprint } from '@src/domain/entity/sprint.ts';
import { useEditField } from '@src/application/ui/tui/runtime/use-edit-field.ts';
import type { UseEditFieldState } from '@src/application/ui/tui/runtime/use-edit-field.ts';
import { useIsMounted } from '@src/application/ui/tui/runtime/use-is-mounted.ts';
import { Result } from '@src/domain/result.ts';
import { glyphs, inkColors, listCapacity, spacing } from '@src/application/ui/tui/theme/tokens.ts';
import { useDeps } from '@src/application/ui/tui/runtime/deps-context.tsx';
import { useAsyncLoad, type AsyncLoadState } from '@src/application/ui/tui/runtime/use-async-load.ts';
import { useRouter } from '@src/application/ui/tui/runtime/router.tsx';
import { useSelection } from '@src/application/ui/tui/runtime/selection-context.tsx';
import { useUiState } from '@src/application/ui/tui/runtime/ui-state-context.tsx';
import { useViewKeys, type ViewKeyBinding } from '@src/application/ui/tui/runtime/use-view-keys.ts';
import { useUnblockTask } from '@src/application/ui/tui/runtime/use-unblock-task.ts';
import { useLaunchCreateSprint } from '@src/application/ui/tui/runtime/use-launch-create-sprint.ts';
import { HelpOverlay } from '@src/application/ui/tui/components/help-overlay.tsx';
import { useBreakpoint } from '@src/application/ui/tui/runtime/use-breakpoint.ts';
import type { Task } from '@src/domain/entity/task.ts';

/**
 * Rendered height (rows) of one {@link SprintRow} card: border top, name, slug, ticket counts,
 * border bottom — plus the section margin below the card.
 */
const ROW_HEIGHT = 5;

/** Pure `succeeded`/`total`/`lastError` → toast-message formatter for a bulk-unblock run. */
const formatUnblockFeedback = (
  succeeded: number,
  total: number,
  lastError: string | undefined,
  sprintName: string
): string =>
  succeeded === total
    ? `${glyphs.check} unblocked ${String(succeeded)} task${succeeded === 1 ? '' : 's'} in "${sprintName}"`
    : `${succeeded > 0 ? glyphs.check : glyphs.cross} unblocked ${String(succeeded)} of ${String(total)}${lastError !== undefined ? ` — ${lastError}` : ''}`;

interface UseStuckSprintTasksResult {
  readonly stuckCount: number;
  readonly unblockAll: (sprint: Sprint | undefined, setFeedback: (text: string | undefined) => void) => Promise<void>;
}

/**
 * Loads the focused sprint's tasks (cancel-safe on sprint change / unmount) and derives the
 * blocked + in_progress subset that `u` can bulk-unblock. `unblockAll` mirrors the original
 * inline handler's mounted-ref-gated ordering: the unblock loop runs unconditionally, a mount
 * check gates the feedback write, and a second mount check (after the further awaited refresh)
 * gates the task-list write — mount state can change between the two awaits.
 */
const useStuckSprintTasks = (sprintId: Sprint['id'] | undefined): UseStuckSprintTasksResult => {
  const deps = useDeps();
  const unblockTask = useUnblockTask();
  const mountedRef = useIsMounted();
  const [tasks, setTasks] = useState<readonly Task[]>([]);

  useEffect(() => {
    if (sprintId === undefined) {
      setTasks([]);
      return undefined;
    }
    let cancelled = false;
    const load = async (): Promise<void> => {
      const r = await deps.taskRepo.findBySprintId(sprintId);
      if (cancelled) return;
      if (r.ok) setTasks(r.value);
    };
    load().catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [sprintId, deps.taskRepo]);

  const stuckTasks = tasks.filter((t) => t.status === 'blocked' || t.status === 'in_progress');

  const unblockAll = async (
    sprint: Sprint | undefined,
    setFeedback: (text: string | undefined) => void
  ): Promise<void> => {
    if (sprint === undefined || stuckTasks.length === 0) return;
    setFeedback(undefined);
    let succeeded = 0;
    let lastError: string | undefined;
    for (const task of stuckTasks) {
      const r = await unblockTask(task, sprint.id);
      if (r.ok) {
        succeeded += 1;
      } else {
        lastError = r.error.message;
      }
    }
    const total = stuckTasks.length;
    if (!mountedRef.current) return;
    setFeedback(formatUnblockFeedback(succeeded, total, lastError, sprint.name));
    // Refresh task list so the hint and count update immediately.
    const refreshed = await deps.taskRepo.findBySprintId(sprint.id);
    if (mountedRef.current && refreshed.ok) setTasks(refreshed.value);
  };

  return { stuckCount: stuckTasks.length, unblockAll };
};

interface SprintRowProps {
  readonly sprint: Sprint;
  readonly focused: boolean;
}

/** `· N pending` / `· N approved` tail on the ticket count. Renders nothing at zero. */
const TicketSubCount = ({
  count,
  label,
  color,
}: {
  readonly count: number;
  readonly label: string;
  readonly color: string;
}): React.JSX.Element | null =>
  count === 0 ? null : (
    <Text>
      <Text dimColor> {glyphs.bullet} </Text>
      <Text bold color={color}>
        {String(count)}
      </Text>
      <Text dimColor> {label}</Text>
    </Text>
  );

/** One sprint card: name + status chip, slug, ticket count with pending/approved sub-counts. */
const SprintRow = ({ sprint, focused }: SprintRowProps): React.JSX.Element => {
  const countBy = (status: string): number => sprint.tickets.filter((t) => t.status === status).length;
  return (
    <Box flexDirection="column" marginBottom={spacing.section}>
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={focused ? inkColors.primary : inkColors.rule}
        borderDimColor={!focused}
        paddingX={spacing.cardPadX}
      >
        <Box justifyContent="space-between">
          <Text bold {...(focused ? { color: inkColors.primary } : {})}>
            {sprint.name}
          </Text>
          <StatusChip label={sprint.status} kind={sprintStatusKind(sprint.status)} />
        </Box>
        <Text dimColor>{sprint.slug}</Text>
        <Text>
          <Text bold>{String(sprint.tickets.length)}</Text>
          <Text dimColor> tickets</Text>
          <TicketSubCount count={countBy('pending')} label="pending" color={inkColors.warning} />
          <TicketSubCount count={countBy('approved')} label="approved" color={inkColors.success} />
        </Text>
      </Box>
    </Box>
  );
};

interface UseSprintRowActionsResult {
  readonly confirmDelete: Sprint | undefined;
  readonly setConfirmDelete: (sprint: Sprint | undefined) => void;
  readonly feedback: string | undefined;
  readonly setFeedback: (text: string | undefined) => void;
  readonly handleRename: (target: Sprint) => void;
  readonly handleDeleteConfirmed: (target: Sprint, confirmed: boolean) => Promise<void>;
}

/**
 * Rename + delete-confirm state and handlers for the focused sprint row, shaped like
 * {@link useLaunchCreateSprint} — the caller (the render + key dispatcher) supplies the
 * `edit` field-prompt hook and `reload` callback it already owns rather than this hook
 * instantiating its own competing instances.
 */
const useSprintRowActions = (edit: UseEditFieldState, reload: () => void): UseSprintRowActionsResult => {
  const deps = useDeps();
  const selection = useSelection();
  // Mounted-ref guard: dismissing the confirm overlay unblocks the router, so the operator can
  // navigate away (unmounting this view) before the awaited repo write resolves. The guard skips
  // the post-await view-local writes (setFeedback / reload) so they never fire into an unmounted
  // tree.
  const mountedRef = useIsMounted();
  const [confirmDelete, setConfirmDelete] = useState<Sprint | undefined>(undefined);
  const [feedback, setFeedback] = useState<string | undefined>(undefined);

  const handleRename = (target: Sprint): void => {
    setFeedback(undefined);
    void edit.openEditPrompt({
      title: `Rename sprint "${target.name}"`,
      kind: 'short',
      currentValue: target.name,
      onSave: async (value) => {
        const renamed = renameSprint(target, value);
        if (!renamed.ok) return Result.error(renamed.error);
        const saved = await deps.sprintRepo.save(renamed.value);
        if (!saved.ok) return Result.error(saved.error);
        if (selection.sprintId === target.id) selection.setSprint(target.id, value.trim(), target.status);
        reload();
        return Result.ok(undefined);
      },
      successLabel: `${glyphs.check} renamed "${target.name}"`,
    });
  };

  const handleDeleteConfirmed = async (target: Sprint, confirmed: boolean): Promise<void> => {
    setConfirmDelete(undefined);
    if (!confirmed) return;
    const r = await deps.sprintRepo.remove(target.id);
    if (!r.ok) {
      if (mountedRef.current) setFeedback(`${glyphs.cross} ${r.error.message}`);
      return;
    }
    // Clearing the deleted sprint's selection targets the always-mounted SelectionProvider, so it
    // runs unconditionally — the stale cursor must drop even if the operator navigated away mid-delete.
    if (selection.sprintId === target.id) selection.setSprint(undefined);
    if (!mountedRef.current) return;
    setFeedback(`${glyphs.check} removed ${target.name}`);
    reload();
  };

  return { confirmDelete, setConfirmDelete, feedback, setFeedback, handleRename, handleDeleteConfirmed };
};

/** Destructive-delete gate for one sprint, spelling out what the cascade takes with it. */
const SprintDeleteConfirm = ({
  sprint,
  onSubmit,
  onCancel,
}: {
  readonly sprint: Sprint;
  readonly onSubmit: (confirmed: boolean) => void;
  readonly onCancel: () => void;
}): React.JSX.Element => (
  <ConfirmCard
    title={
      <Text>
        Remove sprint <Text bold>{sprint.name}</Text>?
      </Text>
    }
    body={
      <Text dimColor>
        Cascades to its execution record + tasks. Tickets stay in the sprint history if you re-create.
      </Text>
    }
    message="Delete?"
    onSubmit={onSubmit}
    onCancel={onCancel}
  />
);

interface SprintsBodyProps {
  readonly helpOpen: boolean;
  readonly confirmDelete: Sprint | undefined;
  readonly onDeleteSubmit: (confirmed: boolean) => void;
  readonly onDeleteCancel: () => void;
  readonly state: AsyncLoadState<readonly Sprint[], unknown>;
  readonly hasProject: boolean;
  readonly list: UseListWindowResult<Sprint>;
  readonly feedback: string | undefined;
}

/** Loading / error / overlay / empty / list-of-cards presentation — pure props in. */
const SprintsBody = ({
  helpOpen,
  confirmDelete,
  onDeleteSubmit,
  onDeleteCancel,
  state,
  hasProject,
  list,
  feedback,
}: SprintsBodyProps): React.JSX.Element => {
  const total = state.kind === 'ok' ? state.value.length : 0;
  // The help screen and the delete gate each take over the whole frame; everything below them is
  // the ordinary async ladder.
  const overlay = helpOpen ? (
    <HelpOverlay />
  ) : confirmDelete !== undefined ? (
    <SprintDeleteConfirm sprint={confirmDelete} onSubmit={onDeleteSubmit} onCancel={onDeleteCancel} />
  ) : undefined;

  return (
    <AsyncListFrame
      {...(overlay !== undefined ? { overlay } : {})}
      state={state}
      loadingLabel="Loading sprints…"
      errorMessage="Failed to load sprints."
      isEmpty={total === 0}
      empty={
        <EmptyState
          title="No sprints yet"
          hint={
            hasProject
              ? 'Press c to start the create-sprint flow.'
              : 'Pick a project first (Projects view) then press c to create one.'
          }
          action={`c ${glyphs.arrowRight} create  ${glyphs.bullet}  esc ${glyphs.arrowRight} back`}
        />
      }
    >
      <Box flexDirection="column">
        <Box flexDirection="column">
          <OverflowRow direction="above" count={list.window.hiddenAbove} />
          {list.visibleItems.map((s, localIdx) => (
            <SprintRow key={s.id} sprint={s} focused={list.window.start + localIdx === list.focusedIndex} />
          ))}
          <OverflowRow direction="below" count={list.window.hiddenBelow} />
        </Box>
        {/* Just the count here — the key affordances live in the router's hint strip
          (`useViewKeys`), the single source of truth that gates `e`/`u` on focus state.
          Duplicating the keys inline would re-advertise them ungated and contradict the gate. */}
        <Box paddingX={spacing.indent} marginTop={spacing.section}>
          <Text dimColor>
            {glyphs.bullet} {total} sprint(s)
          </Text>
        </Box>
        <FeedbackLine text={feedback} />
      </Box>
    </AsyncListFrame>
  );
};

interface SprintsKeysInput {
  readonly focusedSprint: Sprint | undefined;
  readonly stuck: UseStuckSprintTasksResult;
  readonly actions: UseSprintRowActionsResult;
  readonly launchCreateSprint: () => Promise<void>;
  readonly reload: () => void;
}

/**
 * The sprint-list key map. `e` hides its hint on a done sprint but keeps the handler live —
 * someone who found the key in the `?` overlay still presses it, and a swallowed keystroke reads
 * as a bug, so the handler says why instead. `u` goes the other way: with no stuck tasks there is
 * nothing to explain, so the hint and the handler go dark together. Both read the one gate the
 * body of this function derives, so a hint can never disagree with what the key does.
 */
const sprintsKeyBindings = ({
  focusedSprint,
  stuck,
  actions,
  launchCreateSprint,
  reload,
}: SprintsKeysInput): readonly ViewKeyBinding[] => {
  const { setFeedback } = actions;
  const focusedDone = focusedSprint?.status === 'done';
  return [
    { keys: ['↑', '↓'], hint: 'move' },
    { keys: ['↵'], hint: 'open' },
    {
      keys: ['c'],
      hint: 'create',
      run: () => {
        void launchCreateSprint();
      },
    },
    {
      keys: ['e'],
      hint: 'rename',
      hidden: focusedDone,
      run: () => {
        if (focusedSprint === undefined) return;
        if (focusedDone) {
          setFeedback(`${glyphs.cross} done sprints can't be renamed`);
          return;
        }
        actions.handleRename(focusedSprint);
      },
    },
    {
      keys: ['d'],
      hint: 'delete',
      run: () => {
        if (focusedSprint !== undefined) actions.setConfirmDelete(focusedSprint);
      },
    },
    {
      keys: ['r'],
      hint: 'reload',
      run: () => {
        setFeedback(`${glyphs.refresh} reloading…`);
        reload();
      },
    },
    {
      keys: ['u'],
      hint: `unblock (${String(stuck.stuckCount)})`,
      enabled: stuck.stuckCount > 0,
      run: () => {
        void stuck.unblockAll(focusedSprint, setFeedback);
      },
    },
  ];
};

export const SprintsView = (): React.JSX.Element => {
  const deps = useDeps();
  const router = useRouter();
  const selection = useSelection();
  const ui = useUiState();
  const { rows } = useBreakpoint();
  const edit = useEditField();

  const { state, reload } = useAsyncLoad<readonly Sprint[]>(async () => {
    const r = await deps.sprintRepo.list();
    if (!r.ok) throw new Error(r.error.message);
    const scoped =
      selection.projectId !== undefined ? r.value.filter((s) => s.projectId === selection.projectId) : r.value;
    // sprintRepo.list() returns ids ascending (UUIDv7 ≈ creation order); reverse to newest-first
    // so this list matches the home view and the cross-project picker. Copy before sorting —
    // r.value may alias the repository's own array.
    return [...scoped].sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  }, [selection.projectId]);

  const items = state.kind === 'ok' ? state.value : [];
  const actions = useSprintRowActions(edit, reload);
  const { confirmDelete } = actions;

  // Windowed cursor — owns ↑/↓ + j/k + PgUp/PgDn + Home/End + Enter; the cursor is the sprint id,
  // so a reload/reorder keeps focus on the same sprint. Enter selects (sets current + drills in).
  // Disabled while a prompt/help/confirm is up so its keys don't fight the modal.
  const listActive = !ui.modalOpen && confirmDelete === undefined;
  const list = useListWindow<Sprint>({
    items,
    getId: (s) => s.id,
    visibleRows: listCapacity(rows, { rowHeight: ROW_HEIGHT, min: 4, max: 12 }),
    active: listActive,
    onSubmit: (s) => {
      selection.setSprint(s.id, s.name, s.status);
      router.push({ id: 'sprint-detail', props: { sprintId: s.id } });
    },
  });

  const focusedSprint = list.focusedItem ?? items[0];
  // Keyed by sprint id (not the full object) so a reload with semantically-identical data doesn't
  // re-trigger the fetch.
  const stuck = useStuckSprintTasks(focusedSprint?.id);

  // The shared sprint-bound launcher owns the post-completion `selection.setSprint` reseat —
  // wiring it inline here would duplicate the subscriber across every sprint-bound view.
  const launchCreateSprint = useLaunchCreateSprint({
    onError: actions.setFeedback,
    noProjectMessage: `${glyphs.cross} pick a project first (Projects ${glyphs.arrowRight} open one)`,
  });

  useViewKeys(sprintsKeyBindings({ focusedSprint, stuck, actions, launchCreateSprint, reload }), {
    active: listActive,
  });

  return (
    <ViewShell
      title="Sprints"
      subtitle={selection.projectId !== undefined ? 'scoped to current project' : 'all sprints across projects'}
      suppressScrollArrows
    >
      <SprintsBody
        helpOpen={ui.helpOpen}
        confirmDelete={confirmDelete}
        onDeleteSubmit={(value) => {
          if (confirmDelete !== undefined) void actions.handleDeleteConfirmed(confirmDelete, value);
        }}
        onDeleteCancel={() => actions.setConfirmDelete(undefined)}
        state={state}
        hasProject={selection.projectId !== undefined}
        list={list}
        feedback={actions.feedback ?? edit.feedback}
      />
    </ViewShell>
  );
};
