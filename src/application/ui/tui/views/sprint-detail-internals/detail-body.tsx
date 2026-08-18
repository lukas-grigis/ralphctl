/**
 * Sprint detail — view-model.
 *
 * `useSprintDetailBody` owns every hook call and side-effect handler the detail view needs
 * (loading the sprint bundle, the flat focus cursor, inline-expand state, edit / unblock /
 * remove-ticket handlers, footer hints, the local shortcut map) and hands back exactly the
 * props `SprintDetailView` renders. The async action handlers live in `detail-handlers.ts`
 * (`buildSprintDetailHandlers` and the `runUnblock` / `runRemoveTicket` helpers it wraps); the
 * presentational render branch — help overlay > load/error states > remove confirm > the
 * loaded card list — lives in `detail-content.tsx` (`SprintDetailContent`).
 */

import { useEffect, useMemo, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { useEditField } from '@src/application/ui/tui/runtime/use-edit-field.ts';
import { useIsMounted } from '@src/application/ui/tui/runtime/use-is-mounted.ts';
import { usePromptQueue } from '@src/application/ui/tui/prompts/prompt-context.tsx';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { AppDeps } from '@src/application/bootstrap/wire.ts';
import type { Project } from '@src/domain/entity/project.ts';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { Task } from '@src/domain/entity/task.ts';
import type { Ticket } from '@src/domain/entity/ticket.ts';
import { glyphs } from '@src/application/ui/tui/theme/tokens.ts';
import { latestRecordedEvaluation } from '@src/business/task/evaluation-artifact.ts';
import type { EvaluationTarget } from '@src/application/ui/tui/runtime/evaluation-target.ts';
import { useDeps } from '@src/application/ui/tui/runtime/deps-context.tsx';
import { useRouter, useViewProps } from '@src/application/ui/tui/runtime/router.tsx';
import { useUiState } from '@src/application/ui/tui/runtime/ui-state-context.tsx';
import { useViewHints, type ViewHint } from '@src/application/ui/tui/runtime/use-view-hints.tsx';
import { useSelection } from '@src/application/ui/tui/runtime/selection-context.tsx';
import { useUnblockTask } from '@src/application/ui/tui/runtime/use-unblock-task.ts';
import { useSprintDetailShortcuts } from '@src/application/ui/tui/views/sprint-detail-internals/shortcuts.ts';
import {
  buildFocusList,
  sectionWindowCards,
  type FocusItem,
} from '@src/application/ui/tui/views/sprint-detail-internals/focus-list.ts';
import { useListWindow } from '@src/application/ui/tui/components/windowed-list.tsx';
import { useBreakpoint } from '@src/application/ui/tui/runtime/use-breakpoint.ts';
import type { AsyncLoadState } from '@src/application/ui/tui/runtime/use-async-load.ts';
import {
  type SprintBundle,
  useSprintBundle,
} from '@src/application/ui/tui/views/sprint-detail-internals/use-sprint-bundle.ts';
import {
  buildSprintDetailHandlers,
  type SprintDetailHandlers,
} from '@src/application/ui/tui/views/sprint-detail-internals/detail-handlers.ts';
import type { SprintDetailContentProps } from '@src/application/ui/tui/views/sprint-detail-internals/detail-content.tsx';

export interface SprintDetailProps extends Readonly<Record<string, unknown>> {
  readonly sprintId: SprintId;
}

interface FocusedSelection {
  readonly focusedTicket: Ticket | undefined;
  readonly focusedTodoTask: Task | undefined;
  readonly focusedStuckTask: Task | undefined;
  /** Focused task carrying a recorded evaluation verdict — gates the `v` chord and its hint. */
  readonly focusedEvaluatedTask: Task | undefined;
  readonly canEdit: boolean;
}

/**
 * Derive the "what's under the cursor" selection from the flat focus list. Feeds the `e` edit
 * gate, the `u` unblock gate, and the hint row — all three read off this one pass. Pure: same
 * `focusList` + `cursorIdx` + `ticketsEditable` always yields the same selection, so it lives
 * outside the component body as a plain helper rather than a hook.
 */
const deriveFocusedSelection = (
  focusList: readonly FocusItem[],
  cursorIdx: number,
  ticketsEditable: boolean
): FocusedSelection => {
  const focusedNow = focusList[Math.min(cursorIdx, Math.max(0, focusList.length - 1))];
  // "Stuck" covers both `blocked` (maxAttempts exhausted / verify failed) and `in_progress`
  // with a settled last attempt (crash recovery after Ctrl-C / watchdog kill). Both map to the
  // same operator action: press `u` to reset to `todo` and retry on the next implement run.
  const focusedStuckTask =
    focusedNow?.kind === 'task' && (focusedNow.task.status === 'blocked' || focusedNow.task.status === 'in_progress')
      ? focusedNow.task
      : undefined;
  const focusedTicket = focusedNow?.kind === 'ticket' && ticketsEditable ? focusedNow.ticket : undefined;
  const focusedTodoTask =
    focusedNow?.kind === 'task' && focusedNow.task.status === 'todo' ? focusedNow.task : undefined;
  // Any focused task with a verdict on some attempt — status-agnostic on purpose: a done task's
  // passing verdict is as worth reading as a blocked one's critique.
  const focusedEvaluatedTask =
    focusedNow?.kind === 'task' && latestRecordedEvaluation(focusedNow.task) !== undefined
      ? focusedNow.task
      : undefined;
  const canEdit = focusedTicket !== undefined || focusedTodoTask !== undefined;
  return { focusedTicket, focusedTodoTask, focusedStuckTask, focusedEvaluatedTask, canEdit };
};

/** Stable identity for the flat focus list — see the `useMemo` call site for why it matters. */
const focusItemId = (item: FocusItem): string =>
  item.kind === 'ticket' ? `ticket:${String(item.ticket.id)}` : `task:${String(item.task.id)}`;

interface UseFocusModelArgs {
  readonly focusList: readonly FocusItem[];
  readonly ticketsEditable: boolean;
  readonly modalOpen: boolean;
  readonly loaded: boolean;
}

export interface FocusModel extends FocusedSelection {
  readonly cursorIdx: number;
}

/**
 * Own the flat focus cursor (windowed across both the tickets + tasks panes) and the derived
 * "what's under the cursor" selection. `visibleRows` reuses the same per-pane budget the child
 * panes use individually, doubled to cover both sections since the cursor walks them as one
 * flat list even though they render as two panes.
 */
const useFocusModel = (args: UseFocusModelArgs): FocusModel => {
  const { focusList, ticketsEditable, modalOpen, loaded } = args;
  const { rows } = useBreakpoint();
  const focusVisibleRows = Math.max(8, sectionWindowCards(rows) * 2);
  // Id-stable cursor over the flat focus list. Items are keyed as `ticket:<id>` / `task:<id>`
  // matching the entity's stable domain id, so a task-list refresh or reorder keeps focus on
  // the same logical item instead of teleporting to whatever sits at the old index.
  const getFocusItemId = useMemo(() => focusItemId, []);
  const { focusedIndex: cursorIdx } = useListWindow<FocusItem>({
    items: focusList,
    getId: getFocusItemId,
    visibleRows: focusVisibleRows,
    // Navigation keys (↑↓ j/k PgUp/PgDn Home/End) are owned by the hook.
    // The shortcuts hook provides additional view-local keys (a/e/m/d/u/↵/q).
    active: modalOpen === false && loaded,
  });
  return { cursorIdx, ...deriveFocusedSelection(focusList, cursorIdx, ticketsEditable) };
};

interface BuildDetailHintsArgs {
  readonly inDetail: boolean;
  readonly ticketsEditable: boolean;
  readonly canEdit: boolean;
  readonly sprint: Sprint | undefined;
  readonly currentSprintId: SprintId | undefined;
  readonly focusedStuckTask: Task | undefined;
  readonly focusedEvaluatedTask: Task | undefined;
}

/**
 * Build the local footer-hint list. Every hint shares one source of truth with its handler via
 * `enabledWhen`: the `a`/`d` ticket-CRUD chords are gated on `ticketsEditable` (draft only), so
 * the hints must hide on a non-draft sprint or the footer would advertise keys that do nothing.
 * `m` (mark-current) and `u` (unblock) follow the same declarative gate rather than conditional
 * spreads. Pure — lives outside the component so `useViewHints` keeps a plain call site.
 */
const buildDetailHints = (args: BuildDetailHintsArgs): readonly ViewHint[] => {
  const { inDetail, ticketsEditable, canEdit, sprint, currentSprintId, focusedStuckTask, focusedEvaluatedTask } = args;
  return [
    { keys: '↑/↓/j/k', label: 'move' },
    { keys: 'n', label: 'flows' },
    { keys: '↵/o', label: inDetail ? 'expand/collapse' : 'expand' },
    // `esc/q` collapses all expanded cards; only shown while in detail mode so the hint
    // doesn't compete with the global `esc → back` behavior when nothing is expanded.
    { keys: 'esc/q', label: 'collapse all', enabledWhen: inDetail },
    { keys: 'a', label: 'add ticket', enabledWhen: ticketsEditable },
    { keys: 'e', label: 'edit field', enabledWhen: canEdit },
    { keys: 'd', label: 'remove ticket', enabledWhen: ticketsEditable },
    // Surface the `m` chord only when this sprint is not already the current one — once
    // they match, the action is a no-op and the hint adds noise. Suppressed while a
    // stuck task is focused so the `u unblock` hint (a more urgent operator action)
    // stays prominent in the footer without competing for horizontal space.
    {
      keys: 'm',
      label: 'current',
      enabledWhen: sprint !== undefined && currentSprintId !== sprint.id && focusedStuckTask === undefined,
    },
    { keys: 'u', label: 'unblock', enabledWhen: focusedStuckTask !== undefined },
    { keys: 'v', label: 'evaluation', enabledWhen: focusedEvaluatedTask !== undefined },
  ];
};

interface BuildShortcutsActionsArgs {
  readonly selection: ReturnType<typeof useSelection>;
  readonly router: ReturnType<typeof useRouter>;
  readonly setOpenIds: Dispatch<SetStateAction<ReadonlySet<string>>>;
  readonly setConfirmRemove: (ticket: Ticket | undefined) => void;
  readonly setFeedback: (message: string) => void;
  readonly onUnblock: (task: Task) => Promise<void>;
  readonly sprintId: SprintId | undefined;
  readonly openEvaluationOverlay: (target: EvaluationTarget) => void;
}

/**
 * Build the `useSprintDetailShortcuts` action closures (`a`/`m`/↵/`d`/`u`) — spread into the
 * hook's config alongside the plain gate fields so the call site stays a flat list.
 */
const buildShortcutsActions = (args: BuildShortcutsActionsArgs) => {
  const { selection, router, setOpenIds, setConfirmRemove, setFeedback, onUnblock, sprintId, openEvaluationOverlay } =
    args;
  return {
    closeAllExpanded: () => setOpenIds(new Set()),
    openAddTicket: (id: SprintId) => router.push({ id: 'add-ticket', props: { sprintId: id } }),
    toggleExpand: (id: string) =>
      setOpenIds((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      }),
    beginRemove: (ticket: Ticket) => setConfirmRemove(ticket),
    markCurrent: (s: Sprint) => {
      selection.setSprint(s.id, s.name, s.status);
      setFeedback(`${glyphs.check} now on ${s.name}`);
    },
    handleUnblock: (task: Task) => {
      void onUnblock(task);
    },
    // The full target is assembled here (not inside the overlay) so its degrade arms never need a
    // second repository read — see `runtime/evaluation-target.ts`.
    openEvaluation: (task: Task) => {
      const latest = latestRecordedEvaluation(task);
      if (sprintId === undefined || latest === undefined) return;
      openEvaluationOverlay({
        sprintId,
        taskId: String(task.id),
        taskLabel: task.name,
        attemptN: latest.attemptN,
        status: latest.status,
        ...(latest.file.length > 0 ? { file: latest.file } : {}),
        ...(latest.finishedAt !== undefined ? { finishedAt: latest.finishedAt } : {}),
      });
    },
  };
};

export interface UseSprintDetailBodyResult {
  readonly subtitle: string;
  readonly suppressScrollArrows: boolean;
  readonly contentProps: SprintDetailContentProps;
}

interface SprintDetailData {
  readonly deps: AppDeps;
  readonly router: ReturnType<typeof useRouter>;
  readonly ui: ReturnType<typeof useUiState>;
  readonly selection: ReturnType<typeof useSelection>;
  readonly state: AsyncLoadState<SprintBundle, unknown>;
  readonly project: Project | undefined;
  readonly reload: () => void;
  readonly sprint: Sprint | undefined;
  readonly focusList: readonly FocusItem[];
  readonly ticketsEditable: boolean;
  readonly focus: FocusModel;
}

/**
 * Load the sprint bundle and derive the flat focus model from it. Split out of
 * `useSprintDetailBody` purely to keep that hook under the line budget — same hooks, same
 * order, just grouped by "data" vs. "local UI state + handlers + shortcuts".
 */
const useSprintDetailData = (): SprintDetailData => {
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

  // Ticket CRUD is only meaningful in draft. Detail-mode disables hot keys other than esc.
  const ticketsEditable = sprint?.status === 'draft';
  const focus = useFocusModel({
    focusList,
    ticketsEditable: ticketsEditable === true,
    modalOpen: ui.modalOpen,
    loaded: state.kind === 'ok',
  });

  return {
    deps,
    router,
    ui,
    selection,
    state,
    project,
    reload,
    sprint,
    focusList,
    ticketsEditable: ticketsEditable === true,
    focus,
  };
};

interface BuildSprintDetailResultArgs {
  readonly state: AsyncLoadState<SprintBundle, unknown>;
  readonly ui: ReturnType<typeof useUiState>;
  readonly confirmRemove: Ticket | undefined;
  readonly setConfirmRemove: (ticket: Ticket | undefined) => void;
  readonly project: Project | undefined;
  readonly focusList: readonly FocusItem[];
  readonly focus: FocusModel;
  readonly openIds: ReadonlySet<string>;
  readonly ticketsEditable: boolean;
  readonly feedback: string | undefined;
  readonly edit: ReturnType<typeof useEditField>;
  readonly selection: ReturnType<typeof useSelection>;
  readonly handlers: SprintDetailHandlers;
}

/** Assemble the final `{ subtitle, suppressScrollArrows, contentProps }` shape the view renders. */
const buildSprintDetailResult = (args: BuildSprintDetailResultArgs): UseSprintDetailBodyResult => {
  const {
    state,
    ui,
    confirmRemove,
    setConfirmRemove,
    project,
    focusList,
    focus,
    openIds,
    ticketsEditable,
    feedback,
    edit,
    selection,
    handlers,
  } = args;
  return {
    subtitle: state.kind === 'ok' ? state.value.sprint.name : 'loading',
    // The ticket + task panes own the focus cursor (↑/↓ / j/k drive the windowed lists), so the
    // page ScrollRegion must NOT also consume arrows once the list is visible — otherwise both
    // would move on a single keypress. During loading / error the list isn't mounted, so the
    // page scroll keeps its arrows there.
    suppressScrollArrows: state.kind === 'ok',
    contentProps: {
      helpOpen: ui.helpOpen,
      state,
      confirmRemove,
      onCancelRemove: () => setConfirmRemove(undefined),
      onRemoveConfirmed: (target, confirmed) => void handlers.handleRemoveConfirmed(target, confirmed),
      project,
      focusList,
      cursorIdx: focus.cursorIdx,
      openIds,
      ticketsEditable,
      feedback: feedback ?? edit.feedback,
      currentSprintId: selection.sprintId,
    },
  };
};

/**
 * Own every hook call, side-effect handler, and derived value the detail view needs, and hand
 * back exactly the props `SprintDetailView` renders. Splitting this out of the view component
 * keeps the component itself a thin "call the hook, render the shell" wrapper; the state /
 * handler wiring that used to live inline is unchanged, just relocated.
 */
export const useSprintDetailBody = (): UseSprintDetailBodyResult => {
  const { deps, router, ui, selection, state, project, reload, sprint, focusList, ticketsEditable, focus } =
    useSprintDetailData();

  const [openIds, setOpenIds] = useState<ReadonlySet<string>>(() => new Set());
  const [confirmRemove, setConfirmRemove] = useState<Ticket | undefined>(undefined);
  const [feedback, setFeedback] = useState<string | undefined>(undefined);
  const inDetail = openIds.size > 0;

  // Mounted-ref guard for the async unblock / remove-ticket handlers: dismissing the confirm
  // overlay (or firing `u`) unblocks the router, so the operator can navigate away (unmounting
  // this view) before the awaited use-case / flow resolves. The guard skips the post-await
  // view-local writes (setFeedback / reload) so they never fire into an unmounted tree.
  const mountedRef = useIsMounted();

  const edit = useEditField();
  const queue = usePromptQueue();

  useViewHints(
    buildDetailHints({
      inDetail,
      ticketsEditable,
      canEdit: focus.canEdit,
      sprint,
      currentSprintId: selection.sprintId,
      focusedStuckTask: focus.focusedStuckTask,
      focusedEvaluatedTask: focus.focusedEvaluatedTask,
    })
  );

  const unblockTask = useUnblockTask();
  const handlers = buildSprintDetailHandlers({
    sprint,
    deps,
    focus,
    queue,
    edit,
    reload,
    mountedRef,
    setFeedback,
    unblockTask,
    setConfirmRemove,
  });

  useSprintDetailShortcuts({
    modalOpen: ui.modalOpen,
    confirmRemoveActive: confirmRemove !== undefined,
    sprint,
    inDetail,
    ticketsEditable,
    canEdit: focus.canEdit,
    isCurrent: sprint !== undefined && selection.sprintId === sprint.id,
    focusList,
    cursorIdx: focus.cursorIdx,
    focusedStuckTask: focus.focusedStuckTask,
    focusedEvaluatedTask: focus.focusedEvaluatedTask,
    ...buildShortcutsActions({
      selection,
      router,
      setOpenIds,
      setConfirmRemove,
      setFeedback,
      onUnblock: handlers.handleUnblock,
      sprintId: sprint?.id,
      openEvaluationOverlay: ui.openEvaluation,
    }),
    handleEdit: handlers.handleEdit,
  });

  // Claim `esc` while the detail card is open so the local handler can close the card without
  // the global `router.pop()` racing it and dumping the user back to the Sprints list. (The
  // confirm-remove prompt mute is owned by `ConfirmCard`, which claims on mount.)
  const claimEscape = ui.claimEscape;
  useEffect(() => (inDetail ? claimEscape() : undefined), [inDetail, claimEscape]);

  return buildSprintDetailResult({
    state,
    ui,
    confirmRemove,
    setConfirmRemove,
    project,
    focusList,
    focus,
    openIds,
    ticketsEditable,
    feedback,
    edit,
    selection,
    handlers,
  });
};
