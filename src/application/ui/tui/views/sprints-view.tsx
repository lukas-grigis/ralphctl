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
import { ConfirmCard } from '@src/application/ui/tui/components/confirm-card.tsx';
import { renameSprint, type Sprint } from '@src/domain/entity/sprint.ts';
import { loadTaskHealthBySprintId, type TaskHealthCounts } from '@src/application/ui/shared/state-snapshot.ts';
import { useEditField } from '@src/application/ui/tui/runtime/use-edit-field.ts';
import type { UseEditFieldState } from '@src/application/ui/tui/runtime/use-edit-field.ts';
import { useIsMounted } from '@src/application/ui/tui/runtime/use-is-mounted.ts';
import { Result } from '@src/domain/result.ts';
import { glyphs, listCapacity, spacing } from '@src/application/ui/tui/theme/tokens.ts';
import { plural } from '@src/application/ui/shared/plural.ts';
import { useDeps } from '@src/application/ui/tui/runtime/deps-context.tsx';
import { useAsyncLoad, type AsyncLoadState } from '@src/application/ui/tui/runtime/use-async-load.ts';
import { useRouter } from '@src/application/ui/tui/runtime/router.tsx';
import { useSelection } from '@src/application/ui/tui/runtime/selection-context.tsx';
import { useUiState } from '@src/application/ui/tui/runtime/ui-state-context.tsx';
import { useViewKeys } from '@src/application/ui/tui/runtime/use-view-keys.ts';
import { sprintsKeyBindings } from '@src/application/ui/tui/views/sprints-view-internals/key-bindings.ts';
import { useUnblockTask } from '@src/application/ui/tui/runtime/use-unblock-task.ts';
import { useLaunchCreateSprint } from '@src/application/ui/tui/runtime/use-launch-create-sprint.ts';
import { useBreakpoint } from '@src/application/ui/tui/runtime/use-breakpoint.ts';
import type { Task } from '@src/domain/entity/task.ts';
import { ROW_HEIGHT, SprintRow } from '@src/application/ui/tui/views/sprints-view-internals/row-views.tsx';
import {
  formatUnblockFeedback,
  type UnblockFeedbackInput,
} from '@src/application/ui/tui/views/sprints-view-internals/unblock-feedback.ts';

export interface UseStuckSprintTasksResult {
  readonly stuckCount: number;
  readonly unblockAll: (
    sprint: Sprint | undefined,
    setFeedback: (text: string | undefined) => void,
    reload: () => void
  ) => Promise<void>;
}

/**
 * Loads the focused sprint's tasks (cancel-safe on sprint change / unmount) and derives the
 * bulk-unblockable subset. That's `blocked` + `in_progress`, plus — only when neither of those
 * exist and the sprint itself is still `review` — the single stray `todo` task an interrupted
 * `unblockTaskUseCase` `review` → `active` hop can leave behind (`finishInterruptedReopen` in
 * `business/task/unblock-task.ts`). Capped at ONE `todo` task on purpose: that use case's
 * already-`todo` short-circuit persists no task write, so folding every `todo` task on the sprint
 * in here would call it N times over and report "unblocked N tasks" for a run that revived none of
 * them. `unblockAll` mirrors the original inline handler's mounted-ref-gated ordering: the unblock
 * loop runs unconditionally, a mount check gates the feedback write, and a second mount check
 * (after the further awaited refresh) gates the task-list write — mount state can change between
 * the two awaits.
 *
 * `reload` is the outer list loader's own reload (same one `e` / `d` already call on success) —
 * this hook's `tasks` state only feeds the footer hint's stuck count; the card's `· N blocked`
 * sub-count and status chip come from the separate `SprintListEntry` snapshot that loader owns,
 * so without this call a successful bulk unblock left that badge stale until `r` or a remount.
 */
const useStuckSprintTasks = (
  sprintId: Sprint['id'] | undefined,
  sprintStatus: Sprint['status'] | undefined
): UseStuckSprintTasksResult => {
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

  const activeStuck = tasks.filter((t) => t.status === 'blocked' || t.status === 'in_progress');
  // At most one — see the doc comment above for why more would misreport the toast.
  const strandedTodo =
    activeStuck.length === 0 && sprintStatus === 'review' ? tasks.filter((t) => t.status === 'todo').slice(0, 1) : [];
  const stuckTasks = [...activeStuck, ...strandedTodo];

  const unblockAll = async (
    sprint: Sprint | undefined,
    setFeedback: (text: string | undefined) => void,
    reload: () => void
  ): Promise<void> => {
    if (sprint === undefined || stuckTasks.length === 0) return;
    setFeedback(undefined);
    let succeeded = 0;
    let lastError: string | undefined;
    // Counted apart from `lastError`: a refused reopen is not a failed unblock (the task IS
    // revived), so folding it into the error path would under-report `succeeded`.
    let reopenRefused = 0;
    let reopenReason: string | undefined;
    let reopenHint: string | undefined;
    let reopened: UnblockFeedbackInput['reopened'];
    for (const task of stuckTasks) {
      const r = await unblockTask(task, sprint.id);
      if (r.ok) {
        succeeded += 1;
        if (r.value.sprintReopenConflict !== undefined) {
          reopenRefused += 1;
          reopenReason = r.value.sprintReopenConflict.message;
          reopenHint = r.value.sprintReopenConflict.hint;
        }
        const hop = r.value.sprintReopened;
        if (hop !== undefined) reopened = { from: reopened?.from ?? hop.from, to: hop.sprint.status };
      } else {
        lastError = r.error.message;
      }
    }
    const total = stuckTasks.length;
    if (!mountedRef.current) return;
    setFeedback(
      formatUnblockFeedback({
        succeeded,
        total,
        lastError,
        sprintName: sprint.name,
        sprintId: sprint.id,
        reopenRefused,
        reopenReason,
        reopenHint,
        reopened,
      })
    );
    // At least one task actually cleared: re-run the list loader so `SprintListEntry.health`
    // (the row's `· N blocked` badge and status chip) stops reporting the pre-unblock state.
    if (succeeded > 0) reload();
    // Refresh this hook's own task list so the hint and count update immediately.
    const refreshed = await deps.taskRepo.findBySprintId(sprint.id);
    if (mountedRef.current && refreshed.ok) setTasks(refreshed.value);
  };

  return { stuckCount: stuckTasks.length, unblockAll };
};

/**
 * One row's worth of loading — the sprint plus its task-blocked health. Loaded once per list
 * fetch (a single batched `Promise.all` over every sprint in scope), never per rendered row: a
 * per-row fetch would re-run on every scroll / re-render and could stall the list on a project
 * with many sprints.
 */
interface SprintListEntry {
  readonly sprint: Sprint;
  readonly health: TaskHealthCounts;
}

export interface UseSprintRowActionsResult {
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

/** Destructive-delete gate for one sprint, stating what is lost (tickets live in the sprint's own files). */
const SprintDeleteConfirm = ({
  sprint,
  onSubmit,
  onCancel,
}: {
  readonly sprint: Sprint;
  readonly onSubmit: (confirmed: boolean) => void;
  readonly onCancel: () => void;
}): React.JSX.Element => {
  const deps = useDeps();
  const [taskCount, setTaskCount] = useState<number | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    void deps.taskRepo.findBySprintId(sprint.id).then((r) => {
      if (!cancelled && r.ok) setTaskCount(r.value.length);
    });
    return () => {
      cancelled = true;
    };
  }, [deps.taskRepo, sprint.id]);

  const loss =
    taskCount === undefined
      ? `Deletes ${plural(sprint.tickets.length, 'ticket')} and its tasks.`
      : `Deletes ${plural(sprint.tickets.length, 'ticket')} and ${plural(taskCount, 'task')}.`;
  return (
    <ConfirmCard
      verb="Remove"
      target={`sprint "${sprint.name}"`}
      body={<Text dimColor>{loss} This cannot be undone.</Text>}
      onSubmit={onSubmit}
      onCancel={onCancel}
    />
  );
};

interface SprintsBodyProps {
  readonly confirmDelete: Sprint | undefined;
  readonly onDeleteSubmit: (confirmed: boolean) => void;
  readonly onDeleteCancel: () => void;
  readonly state: AsyncLoadState<readonly SprintListEntry[], unknown>;
  readonly hasProject: boolean;
  readonly list: UseListWindowResult<SprintListEntry>;
  readonly feedback: string | undefined;
}

/** Loading / error / overlay / empty / list-of-cards presentation — pure props in. */
const SprintsBody = ({
  confirmDelete,
  onDeleteSubmit,
  onDeleteCancel,
  state,
  hasProject,
  list,
  feedback,
}: SprintsBodyProps): React.JSX.Element => {
  const total = state.kind === 'ok' ? state.value.length : 0;
  // The delete gate takes over the whole frame; everything below it is the ordinary async ladder.
  const overlay =
    confirmDelete !== undefined ? (
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
          {list.visibleItems.map((entry, localIdx) => (
            <SprintRow
              key={entry.sprint.id}
              sprint={entry.sprint}
              health={entry.health}
              focused={list.window.start + localIdx === list.focusedIndex}
            />
          ))}
          <OverflowRow direction="below" count={list.window.hiddenBelow} />
        </Box>
        {/* Just the count here — the key affordances live in the router's hint strip
          (`useViewKeys`), the single source of truth that gates `e`/`u` on focus state.
          Duplicating the keys inline would re-advertise them ungated and contradict the gate. */}
        <Box paddingX={spacing.indent} marginTop={spacing.section}>
          <Text dimColor>
            {glyphs.bullet} {plural(total, 'sprint')}
          </Text>
        </Box>
        <FeedbackLine text={feedback} />
      </Box>
    </AsyncListFrame>
  );
};

export const SprintsView = (): React.JSX.Element => {
  const deps = useDeps();
  const router = useRouter();
  const selection = useSelection();
  const ui = useUiState();
  const { rows } = useBreakpoint();
  const edit = useEditField();

  const { state, reload } = useAsyncLoad<readonly SprintListEntry[]>(async () => {
    const r = await deps.sprintRepo.list();
    if (!r.ok) throw new Error(r.error.message);
    const scoped =
      selection.projectId !== undefined ? r.value.filter((s) => s.projectId === selection.projectId) : r.value;
    // sprintRepo.list() returns ids ascending (UUIDv7 ≈ creation order); reverse to newest-first
    // so this list matches the home view and the cross-project picker. Copy before sorting —
    // r.value may alias the repository's own array.
    const sorted = [...scoped].sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
    // Task-blocked health folded into THIS loader via the shared batch helper — one
    // `Promise.all` per list load, not a fetch per rendered row (see its doc comment for why).
    const healthBySprintId = await loadTaskHealthBySprintId(deps.taskRepo, sorted);
    return sorted.map((sprint) => ({
      sprint,
      health: healthBySprintId.get(sprint.id) ?? { blockedTaskCount: 0, upstreamBlockedTaskCount: 0 },
    }));
  }, [selection.projectId]);

  const items = state.kind === 'ok' ? state.value : [];
  const actions = useSprintRowActions(edit, reload);
  const { confirmDelete } = actions;

  // Windowed cursor — owns ↑/↓ + j/k + PgUp/PgDn + Home/End + Enter; the cursor is the sprint id,
  // so a reload/reorder keeps focus on the same sprint. Enter opens the sprint detail (browse only).
  // Disabled while a prompt/help/confirm is up so its keys don't fight the modal.
  const listActive = !ui.modalOpen && confirmDelete === undefined;
  const list = useListWindow<SprintListEntry>({
    items,
    getId: (entry) => entry.sprint.id,
    visibleRows: listCapacity(rows, { rowHeight: ROW_HEIGHT, min: 4, max: 12 }),
    active: listActive,
    onSubmit: (entry) => {
      // Browse only — the selection is untouched (`m` makes a sprint current). The crumb is
      // labelled from the route's own sprint name, not the selection.
      router.push({ id: 'sprint-detail', props: { sprintId: entry.sprint.id, sprintName: entry.sprint.name } });
    },
  });

  const focusedSprint = (list.focusedItem ?? items[0])?.sprint;
  // Keyed by sprint id + status (not the full object) so a reload with semantically-identical
  // data doesn't re-trigger the fetch; status is included because it gates the stranded-`todo`
  // case above.
  const stuck = useStuckSprintTasks(focusedSprint?.id, focusedSprint?.status);

  // The shared sprint-bound launcher owns the post-completion `selection.setSprint` reseat —
  // wiring it inline here would duplicate the subscriber across every sprint-bound view.
  const launchCreateSprint = useLaunchCreateSprint({
    onError: actions.setFeedback,
    noProjectMessage: `${glyphs.cross} pick a project first (Projects ${glyphs.arrowRight} open one)`,
  });

  const makeCurrent = (sprint: Sprint): void => {
    selection.setSprint(sprint.id, sprint.name, sprint.status);
    actions.setFeedback(`${glyphs.check} now on ${sprint.name}`);
  };

  useViewKeys(
    sprintsKeyBindings({
      focusedSprint,
      stuck,
      actions,
      launchCreateSprint,
      reload,
      currentSprintId: selection.sprintId,
      makeCurrent,
    }),
    { active: listActive }
  );

  return (
    <ViewShell
      title="Sprints"
      subtitle={selection.projectId !== undefined ? 'scoped to current project' : 'all sprints across projects'}
      suppressScrollArrows
    >
      <SprintsBody
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
