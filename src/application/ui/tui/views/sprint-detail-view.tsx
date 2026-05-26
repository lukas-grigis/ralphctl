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
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { Result } from '@src/domain/result.ts';
import { replaceTicket } from '@src/domain/entity/sprint.ts';
import {
  setTicketDescription,
  setTicketRequirements,
  setTicketTitle,
  type ApprovedTicket,
} from '@src/domain/entity/ticket.ts';
import { updateTask } from '@src/domain/entity/task.ts';
import { useEditField, type OpenEditPromptInput } from '@src/application/ui/tui/runtime/use-edit-field.ts';
import { usePromptQueue } from '@src/application/ui/tui/prompts/prompt-context.tsx';
import { ViewShell } from '@src/application/ui/tui/components/view-shell.tsx';
import { Card } from '@src/application/ui/tui/components/card.tsx';
import { ListCard } from '@src/application/ui/tui/components/list-card.tsx';
import { FieldList } from '@src/application/ui/tui/components/field-list.tsx';
import {
  StatusChip,
  type StatusKind,
  sprintStatusKind,
  ticketStatusKind,
  taskStatusKind,
} from '@src/application/ui/tui/components/status-chip.tsx';
import { PipelineMap } from '@src/application/ui/tui/components/pipeline-map.tsx';
import { EmptyState } from '@src/application/ui/tui/components/empty-state.tsx';
import { Spinner } from '@src/application/ui/tui/components/spinner.tsx';
import { ConfirmPrompt } from '@src/application/ui/tui/prompts/confirm-prompt.tsx';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { Project } from '@src/domain/entity/project.ts';
import type { Task } from '@src/domain/entity/task.ts';
import type { Attempt } from '@src/domain/entity/attempt.ts';
import type { Ticket } from '@src/domain/entity/ticket.ts';
import type { RepositoryId } from '@src/domain/value/id/repository-id.ts';
import { glyphs, inkColors, spacing } from '@src/application/ui/tui/theme/tokens.ts';
import { useBreakpoint } from '@src/application/ui/tui/runtime/use-breakpoint.ts';
import { fmtDuration, fmtIsoAbsolute } from '@src/application/ui/tui/theme/duration.ts';
import { useDeps } from '@src/application/ui/tui/runtime/deps-context.tsx';
import { useAsyncLoad } from '@src/application/ui/tui/runtime/use-async-load.ts';
import { useRouter, useViewProps } from '@src/application/ui/tui/runtime/router.tsx';
import { useUiState } from '@src/application/ui/tui/runtime/ui-state-context.tsx';
import { useViewHints } from '@src/application/ui/tui/runtime/use-view-hints.tsx';
import { HelpOverlay } from '@src/application/ui/tui/components/help-overlay.tsx';
import { useSelection } from '@src/application/ui/tui/runtime/selection-context.tsx';
import { useSessionManager } from '@src/application/ui/tui/runtime/sessions-context.tsx';
import { createTicketRemoveFlow } from '@src/application/flows/ticket-remove/flow.ts';
import { unblockTaskUseCase } from '@src/business/task/unblock-task.ts';

interface SprintDetailProps extends Readonly<Record<string, unknown>> {
  readonly sprintId: SprintId;
}

interface SprintBundle {
  readonly sprint: Sprint;
  readonly tasks: readonly Task[];
}

type FocusItem = { readonly kind: 'ticket'; readonly ticket: Ticket } | { readonly kind: 'task'; readonly task: Task };

const buildFocusList = (sprint: Sprint, tasks: readonly Task[]): readonly FocusItem[] => [
  ...sprint.tickets.map((ticket) => ({ kind: 'ticket' as const, ticket })),
  ...tasks.map((task) => ({ kind: 'task' as const, task })),
];

export const SprintDetailView = (): React.JSX.Element => {
  const deps = useDeps();
  const router = useRouter();
  const ui = useUiState();
  const { sprintId } = useViewProps<SprintDetailProps>();
  const selection = useSelection();

  const { state, reload } = useAsyncLoad<SprintBundle>(async () => {
    // Sprint + tasks lookups are independent — fetch in parallel so the view paints faster on
    // navigation. Project lookup happens in a separate best-effort effect below.
    const [sprintR, tasksR] = await Promise.all([
      deps.sprintRepo.findById(sprintId),
      deps.taskRepo.findBySprintId(sprintId),
    ]);
    if (!sprintR.ok) throw new Error(sprintR.error.message);
    if (!tasksR.ok) throw new Error(tasksR.error.message);
    return { sprint: sprintR.value, tasks: tasksR.value };
  }, [sprintId]);

  // Reload sprint + tasks whenever a flow session transitions (registered, running →
  // completed / failed / aborted, or removed). Without this, cancelling, finishing, or failing a
  // flow leaves sprint-detail frozen on its mount-time snapshot — the operator can't see that
  // the active task flipped to `blocked` or that subsequent tasks landed `done`. We diff
  // session statuses rather than reloading on every notify() because the session manager fires
  // on every chain `step`; the trace-only updates would otherwise hammer the disk.
  // `reload` is a fresh closure each render (no useCallback in useAsyncLoad), so we route it
  // through a ref to keep the subscription stable.
  const sessionMgr = useSessionManager();
  const reloadRef = React.useRef(reload);
  reloadRef.current = reload;
  React.useEffect(() => {
    const snapshot = (): Map<string, string> => {
      const m = new Map<string, string>();
      for (const rec of sessionMgr.list()) m.set(rec.descriptor.id, rec.descriptor.status);
      return m;
    };
    let prev = snapshot();
    return sessionMgr.subscribe(() => {
      const next = snapshot();
      let changed = prev.size !== next.size;
      if (!changed) {
        for (const [id, status] of next) {
          if (prev.get(id) !== status) {
            changed = true;
            break;
          }
        }
      }
      prev = next;
      if (changed) reloadRef.current();
    });
  }, [sessionMgr]);

  // Project lookup is a separate, best-effort fetch — used only to resolve `repositoryId → name`
  // for task cards / detail views. Failing this (test stubs without a real projectRepo, or a
  // stale sprint pointing at a deleted project) must not break the view; we render with raw
  // repo ids while the lookup hasn't resolved.
  const [project, setProject] = useState<Project | undefined>(undefined);
  React.useEffect(() => {
    if (state.kind !== 'ok') {
      setProject(undefined);
      return undefined;
    }
    let cancelled = false;
    const lookup = async (): Promise<void> => {
      const finder = deps.projectRepo?.findById?.bind(deps.projectRepo);
      if (typeof finder !== 'function') return;
      const r = await finder(state.value.sprint.projectId);
      if (cancelled) return;
      if (r.ok) setProject(r.value);
      else {
        // Don't blow up the view — but surface the reason so an operator wondering why repo
        // names render as raw uuids can find it in the log instead of silently shrugging.
        deps.logger?.warn?.('sprint-detail: project lookup failed', {
          projectId: String(state.value.sprint.projectId),
          error: r.error.message,
        });
      }
    };
    lookup().catch((err: unknown) => {
      deps.logger?.warn?.('sprint-detail: project lookup threw', {
        projectId: String(state.value.sprint.projectId),
        error: err instanceof Error ? err.message : String(err),
      });
    });
    return () => {
      cancelled = true;
    };
  }, [state, deps.projectRepo, deps.logger]);

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

  useViewHints([
    { keys: 'n', label: 'flows' },
    { keys: '↵/o', label: inDetail ? 'expand/collapse' : 'expand' },
    { keys: 'a', label: 'add ticket' },
    ...(canEdit ? [{ keys: 'e', label: 'edit field' }] : []),
    { keys: 'd', label: 'remove ticket' },
    // Surface the `m` chord only when this sprint is not already the current one — once
    // they match, the action is a no-op and the hint adds noise. Suppressed while a
    // stuck task is focused so the `u unblock` hint (a more urgent operator action)
    // stays prominent in the footer without competing for horizontal space.
    ...(sprint !== undefined && selection.sprintId !== sprint.id && focusedStuckTask === undefined
      ? [{ keys: 'm', label: 'current' }]
      : []),
    ...(focusedStuckTask !== undefined ? [{ keys: 'u', label: 'unblock' }] : []),
  ]);

  type TicketFieldKey = 'title' | 'description' | 'requirements';
  type TaskFieldKey = 'name' | 'description';

  const buildTicketEdit = (ticket: Ticket, field: TicketFieldKey): OpenEditPromptInput | undefined => {
    if (sprint === undefined) return undefined;
    if (field === 'requirements' && ticket.status !== 'approved') {
      return undefined;
    }
    const current =
      field === 'title'
        ? ticket.title
        : field === 'description'
          ? (ticket.description ?? '')
          : (ticket as ApprovedTicket).requirements;
    return {
      title: `Edit ticket ${field} — "${ticket.title}"`,
      kind: field === 'title' ? 'short' : 'long',
      currentValue: current,
      onSave: async (value) => {
        const updated =
          field === 'title'
            ? setTicketTitle(ticket, value)
            : field === 'description'
              ? setTicketDescription(ticket, value.length === 0 ? undefined : value)
              : ticket.status === 'approved'
                ? setTicketRequirements(ticket, value)
                : Result.ok(ticket);
        if (!updated.ok) return Result.error(updated.error);
        const replaced = replaceTicket(sprint, ticket.id, updated.value);
        if (!replaced.ok) return Result.error(replaced.error);
        const saved = await deps.sprintRepo.save(replaced.value);
        if (!saved.ok) return Result.error(saved.error);
        reload();
        return Result.ok(undefined);
      },
      successLabel: `✓ updated ticket ${field}`,
    };
  };

  const buildTaskEdit = (task: Task, field: TaskFieldKey): OpenEditPromptInput | undefined => {
    if (sprint === undefined || task.status !== 'todo') return undefined;
    const current = field === 'name' ? task.name : (task.description ?? '');
    return {
      title: `Edit task ${field} — "${task.name}"`,
      kind: field === 'name' ? 'short' : 'long',
      currentValue: current,
      onSave: async (value) => {
        const update = field === 'name' ? { name: value } : { description: value.length === 0 ? null : value };
        const next = updateTask(task, update);
        if (!next.ok) return Result.error(next.error);
        const saved = await deps.taskRepo.update(sprint.id, next.value);
        if (!saved.ok) return Result.error(saved.error);
        reload();
        return Result.ok(undefined);
      },
      successLabel: `✓ updated task ${field}`,
    };
  };

  const handleEdit = (): void => {
    if (focusedTicket !== undefined) {
      const options: ReadonlyArray<{ readonly label: string; readonly value: TicketFieldKey }> = [
        { label: 'title', value: 'title' },
        { label: 'description', value: 'description' },
        ...(focusedTicket.status === 'approved'
          ? ([{ label: 'requirements', value: 'requirements' as const }] as const)
          : []),
      ];
      if (options.length === 1) {
        const cfg = buildTicketEdit(focusedTicket, 'title');
        if (cfg !== undefined) void edit.openEditPrompt(cfg);
        return;
      }
      new Promise<TicketFieldKey>((resolve, reject) => {
        queue.enqueue({ kind: 'choice', message: 'Edit which ticket field?', options, resolve, reject });
      })
        .then((field) => {
          const cfg = buildTicketEdit(focusedTicket, field);
          if (cfg !== undefined) void edit.openEditPrompt(cfg);
        })
        .catch(() => undefined);
      return;
    }
    if (focusedTodoTask !== undefined) {
      const options: ReadonlyArray<{ readonly label: string; readonly value: TaskFieldKey }> = [
        { label: 'name', value: 'name' },
        { label: 'description', value: 'description' },
      ];
      new Promise<TaskFieldKey>((resolve, reject) => {
        queue.enqueue({ kind: 'choice', message: 'Edit which task field?', options, resolve, reject });
      })
        .then((field) => {
          const cfg = buildTaskEdit(focusedTodoTask, field);
          if (cfg !== undefined) void edit.openEditPrompt(cfg);
        })
        .catch(() => undefined);
    }
  };

  useInput((input, key) => {
    if (ui.helpOpen || ui.promptActive || confirmRemove !== undefined || sprint === undefined) return;
    // Esc/q collapses every expanded card in one action; falls through to global pop otherwise.
    if ((key.escape || input === 'q') && inDetail) {
      setOpenIds(new Set());
      return;
    }
    if (input === 'a' && ticketsEditable) {
      router.push({ id: 'add-ticket', props: { sprintId: sprint.id } });
      return;
    }
    if (input === 'e' && canEdit) {
      handleEdit();
      return;
    }
    if (input === 'm') {
      // Explicit "make this sprint current". Replaces the prior silent auto-sync on mount —
      // the user now opts in. No-op if already current so re-pressing doesn't churn feedback.
      if (selection.sprintId !== sprint.id) {
        selection.setSprint(sprint.id, sprint.name);
        setFeedback(`✓ now on ${sprint.name}`);
      }
      return;
    }
    if ((key.downArrow || input === 'j') && focusList.length > 0) {
      setCursorIdx((c) => Math.min(focusList.length - 1, c + 1));
      return;
    }
    if ((key.upArrow || input === 'k') && focusList.length > 0) {
      setCursorIdx((c) => Math.max(0, c - 1));
      return;
    }
    if ((key.return || input === 'o') && focusList.length > 0) {
      const target = focusList[Math.min(cursorIdx, focusList.length - 1)];
      if (target === undefined) return;
      const targetId = target.kind === 'ticket' ? String(target.ticket.id) : String(target.task.id);
      setOpenIds((prev) => {
        const next = new Set(prev);
        if (next.has(targetId)) next.delete(targetId);
        else next.add(targetId);
        return next;
      });
      return;
    }
    if (input === 'd' && ticketsEditable) {
      const focused = focusList[Math.min(cursorIdx, focusList.length - 1)];
      if (focused?.kind === 'ticket') setConfirmRemove(focused.ticket);
      return;
    }
    if (input === 'u' && focusedStuckTask !== undefined) {
      void handleUnblock(focusedStuckTask);
    }
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

  const handleUnblock = async (target: Task): Promise<void> => {
    if (sprint === undefined) return;
    const r = await unblockTaskUseCase({
      task: target,
      sprintId: sprint.id,
      taskRepo: deps.taskRepo,
      logger: deps.logger,
    });
    if (!r.ok) {
      setFeedback(`✗ ${r.error.message}`);
      return;
    }
    setFeedback(`✓ unblocked "${target.name}"`);
    reload();
  };

  return (
    <ViewShell title="Sprint" subtitle={state.kind === 'ok' ? state.value.sprint.name : 'loading'}>
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
          ticketsEditable={ticketsEditable}
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
  const action = phaseAction(sprint, tasks);
  return (
    <Box flexDirection="column">
      <SprintHeader sprint={sprint} tasks={tasks} isCurrent={isCurrent} />

      {action !== undefined &&
        (sprint.status === 'done' ? (
          <Box paddingX={spacing.indent} marginTop={spacing.section}>
            <Text dimColor>
              {glyphs.check} {action.hint}
            </Text>
          </Box>
        ) : (
          <Box marginTop={spacing.section}>
            <Card title="Next phase" tone="primary">
              <Box flexDirection="column" paddingX={spacing.indent}>
                <Text bold color={inkColors.primary}>
                  {glyphs.actionCursor} {action.label}
                </Text>
                <Box marginTop={1}>
                  <Text dimColor>{action.hint}</Text>
                </Box>
              </Box>
            </Card>
          </Box>
        ))}

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

      <Box paddingX={spacing.indent} marginTop={spacing.section}>
        <Text dimColor>
          {glyphs.bullet} ↑/↓ focus {glyphs.bullet} ↵/o expand/collapse {glyphs.bullet} n flows {glyphs.bullet} esc back
        </Text>
      </Box>
    </Box>
  );
};

interface PhaseAction {
  readonly label: string;
  readonly hint: string;
}

const phaseAction = (sprint: Sprint, tasks: readonly Task[]): PhaseAction | undefined => {
  const pending = sprint.tickets.filter((t) => t.status === 'pending').length;
  const approved = sprint.tickets.filter((t) => t.status === 'approved').length;
  const todo = tasks.filter((t) => t.status === 'todo').length;
  switch (sprint.status) {
    case 'draft':
      if (sprint.tickets.length === 0) {
        return { label: 'Add tickets', hint: 'Press a to start adding inputs to this sprint.' };
      }
      if (pending > 0) {
        return {
          label: `Refine ${String(pending)} pending ticket(s)`,
          hint: 'Press n → refine. Tickets become inputs for plan once approved.',
        };
      }
      if (approved > 0) {
        return {
          label: `Plan ${String(approved)} approved ticket(s)`,
          hint: 'Press n → plan. Generates a dependency-ordered task list.',
        };
      }
      return undefined;
    case 'planned':
    case 'active':
      if (todo > 0) {
        return {
          label: `Implement ${String(todo)} pending task(s)`,
          hint: 'Press n → implement. The loop picks tasks in dependency order and commits as it goes.',
        };
      }
      return { label: 'Review pending tasks', hint: 'No todo tasks — check the list below for blocked / done.' };
    case 'review':
      return {
        label: 'Open a pull request, then close',
        hint: 'Press n → create-pr to surface for human approval, then n → close-sprint when you are done.',
      };
    case 'done':
      return {
        label: 'Sprint closed',
        hint: 'No further work happens here. Press S to switch to another sprint.',
      };
  }
};

// ─── Sprint header ────────────────────────────────────────────────────────────────────────────

const SprintHeader = ({
  sprint,
  tasks,
  isCurrent,
}: {
  readonly sprint: Sprint;
  readonly tasks: readonly Task[];
  readonly isCurrent: boolean;
}): React.JSX.Element => {
  const done = tasks.filter((t) => t.status === 'done').length;
  const blocked = tasks.filter((t) => t.status === 'blocked').length;
  // The `· current` badge lives on the right next to the status chip — Card's `title` is a
  // plain string, and stacking the badge alongside the chip keeps the right rail expressing
  // selection + lifecycle in one glance without overloading either onto the title slot.
  const rightSide = (
    <Box>
      {isCurrent && (
        <Text dimColor italic>
          {glyphs.bullet} current{'  '}
        </Text>
      )}
      <StatusChip label={sprint.status} kind={sprintStatusKind(sprint.status)} />
    </Box>
  );
  return (
    <Card title={sprint.name} tone="primary" right={rightSide}>
      <FieldList
        fields={[
          { label: 'Slug', value: sprint.slug },
          { label: 'Tickets', value: String(sprint.tickets.length) },
          {
            label: 'Tasks',
            value: `${String(tasks.length)}  (${String(done)} done · ${String(blocked)} blocked)`,
          },
        ]}
      />
      <Box marginTop={1}>
        <PhaseTimeline sprint={sprint} />
      </Box>
      <Box marginTop={1}>
        <PipelineMap status={sprint.status} />
      </Box>
    </Card>
  );
};

/**
 * Inline phase ribbon with elapsed-between-transitions. We can't show the draft duration —
 * sprints don't carry a `createdAt` — but every later transition timestamp is on the entity,
 * so the ribbon reads like `planned · 2025-05-10  → active · 3h  → review · 1d2h  → done · 4h`.
 * When a phase is the current one (no later timestamp), it shows `ongoing for X` instead.
 *
 * Robust to test fixtures that store `undefined` instead of `null` for unreached phases: both
 * are filtered out via `!= null` (the loose equality on purpose).
 */
const PhaseTimeline = ({ sprint }: { readonly sprint: Sprint }): React.JSX.Element => {
  const now = Date.now();
  interface PhaseDef {
    readonly label: string;
    readonly at: string | null | undefined;
    readonly nextAt: string | null | undefined;
  }
  const phases: readonly PhaseDef[] = [
    { label: 'planned', at: sprint.plannedAt, nextAt: sprint.activatedAt },
    { label: 'active', at: sprint.activatedAt, nextAt: sprint.reviewAt },
    { label: 'review', at: sprint.reviewAt, nextAt: sprint.doneAt },
    { label: 'done', at: sprint.doneAt, nextAt: null },
  ];
  const hasAt = (p: PhaseDef): p is PhaseDef & { readonly at: string } => p.at !== null && p.at !== undefined;
  const noNextAt = (next: string | null | undefined): boolean => next === null || next === undefined;
  const cells = phases.filter(hasAt).map((p, i, all) => {
    const sameAsLast = i === all.length - 1;
    const startedMs = Date.parse(p.at);
    const elapsedMs = (() => {
      if (!noNextAt(p.nextAt)) {
        const ended = Date.parse(p.nextAt!);
        return Number.isFinite(ended) && Number.isFinite(startedMs) ? ended - startedMs : undefined;
      }
      if (sameAsLast && sprint.status !== 'done') {
        return Number.isFinite(startedMs) ? now - startedMs : undefined;
      }
      return undefined;
    })();
    return {
      label: p.label,
      absolute: fmtIsoAbsolute(p.at),
      elapsed: elapsedMs !== undefined ? fmtDuration(elapsedMs) : undefined,
      ongoing: noNextAt(p.nextAt) && sprint.status !== 'done',
    };
  });
  if (cells.length === 0) {
    return (
      <Text dimColor>
        {glyphs.bullet} draft {glyphs.bullet} no transitions yet
      </Text>
    );
  }
  return (
    <Box flexDirection="column" paddingLeft={2}>
      {cells.map((c, idx) => (
        <Box key={`${c.label}-${String(idx)}`}>
          <Text dimColor>{glyphs.activityArrow} </Text>
          <Text bold>{c.label}</Text>
          <Text dimColor>
            {' '}
            {glyphs.bullet} {c.absolute}
          </Text>
          {c.elapsed !== undefined && (
            <Text color={c.ongoing ? inkColors.info : inkColors.muted}>
              {' '}
              {glyphs.bullet} {c.ongoing ? 'ongoing ' : 'lasted '}
              {c.elapsed}
            </Text>
          )}
        </Box>
      ))}
    </Box>
  );
};

// ─── Tickets section ──────────────────────────────────────────────────────────────────────────

interface TicketsSectionProps {
  readonly sprint: Sprint;
  readonly tasks: readonly Task[];
  readonly focusList: readonly FocusItem[];
  readonly cursorIdx: number;
  readonly ticketsEditable: boolean;
  readonly feedback: string | undefined;
  readonly openIds: ReadonlySet<string>;
}

const TicketsSection = ({
  sprint,
  tasks,
  focusList,
  cursorIdx,
  ticketsEditable,
  feedback,
  openIds,
}: TicketsSectionProps): React.JSX.Element => (
  <Box marginTop={spacing.section} flexDirection="column">
    <Text bold>{glyphs.badge} Tickets</Text>
    {sprint.tickets.length === 0 ? (
      <Box marginTop={1}>
        <EmptyState
          title="No tickets yet"
          hint={
            ticketsEditable ? 'Press a to add the first one.' : 'Sprint is no longer in draft — tickets are frozen.'
          }
        />
      </Box>
    ) : (
      <Box flexDirection="column" marginTop={1}>
        {sprint.tickets.map((ticket, idx) => {
          const focused = focusList[cursorIdx]?.kind === 'ticket' && focusList[cursorIdx]?.ticket.id === ticket.id;
          const expanded = openIds.has(String(ticket.id));
          const taskCount = tasks.filter((t) => t.ticketId === ticket.id).length;
          return (
            <TicketCard
              key={ticket.id}
              ticket={ticket}
              tasks={tasks}
              taskCount={taskCount}
              focused={focused}
              expanded={expanded}
              index={idx}
            />
          );
        })}
      </Box>
    )}
    <Box paddingX={spacing.indent} marginTop={spacing.section}>
      <Text dimColor>
        {ticketsEditable
          ? `${glyphs.bullet} a add ${glyphs.bullet} ↵/o expand/collapse ${glyphs.bullet} d remove`
          : `${glyphs.bullet} tickets frozen (sprint not in draft) ${glyphs.bullet} ↵/o expand/collapse`}
      </Text>
    </Box>
    {feedback !== undefined && (
      <Box paddingX={spacing.indent} marginTop={1}>
        <Text color={feedback.startsWith('✗') ? inkColors.error : inkColors.primary}>{feedback}</Text>
      </Box>
    )}
  </Box>
);

const TicketCard = ({
  ticket,
  tasks,
  taskCount,
  focused,
  expanded,
  index,
}: {
  readonly ticket: Ticket;
  readonly tasks: readonly Task[];
  readonly taskCount: number;
  readonly focused: boolean;
  readonly expanded: boolean;
  readonly index: number;
}): React.JSX.Element => (
  <ListCard
    focused={focused}
    rightSlot={<StatusChip label={ticket.status} kind={ticketStatusKind(ticket.status)} />}
    indexLabel={`#${String(index + 1)}`}
    title={ticket.title}
  >
    <Box>
      <Text dimColor>
        {glyphs.bullet} {String(taskCount)} task{taskCount === 1 ? '' : 's'}
      </Text>
      {ticket.link !== undefined && (
        <Text dimColor>
          {' '}
          {glyphs.bullet} {String(ticket.link)}
        </Text>
      )}
      {ticket.status === 'approved' && <Text dimColor> {glyphs.bullet} requirements ✓</Text>}
    </Box>
    {!expanded && ticket.description !== undefined && <Description text={ticket.description} maxLines={2} />}
    {expanded && <TicketDetailBody ticket={ticket} tasks={tasks} />}
  </ListCard>
);

// ─── Tasks section ────────────────────────────────────────────────────────────────────────────

interface TasksSectionProps {
  readonly sprint: Sprint;
  readonly tasks: readonly Task[];
  readonly focusList: readonly FocusItem[];
  readonly cursorIdx: number;
  readonly project: Project | undefined;
  readonly openIds: ReadonlySet<string>;
}

const TasksSection = ({
  sprint,
  tasks,
  focusList,
  cursorIdx,
  project,
  openIds,
}: TasksSectionProps): React.JSX.Element => (
  <Box marginTop={spacing.section} flexDirection="column">
    <Text bold>{glyphs.badge} Tasks</Text>
    {tasks.length === 0 ? (
      <Box marginTop={1}>
        <EmptyState title="No tasks yet" hint="Run plan from Flows (n) once tickets are approved." />
      </Box>
    ) : (
      <Box flexDirection="column" marginTop={1}>
        {tasks.map((task, idx) => {
          const focusItem = focusList[cursorIdx];
          const focused = focusItem?.kind === 'task' && focusItem.task.id === task.id;
          const expanded = openIds.has(String(task.id));
          const ticket = sprint.tickets.find((t) => t.id === task.ticketId);
          const repoName = repositoryName(project, task.repositoryId);
          return (
            <TaskCard
              key={task.id}
              task={task}
              sprint={sprint}
              tasks={tasks}
              project={project}
              ticketTitle={ticket?.title}
              repoName={repoName}
              focused={focused}
              expanded={expanded}
              index={idx + 1}
            />
          );
        })}
      </Box>
    )}
    <Box paddingX={spacing.indent} marginTop={spacing.section}>
      <Text dimColor>{glyphs.bullet} ↵/o expand/collapse</Text>
    </Box>
  </Box>
);

const TaskCard = ({
  task,
  sprint,
  tasks,
  project,
  ticketTitle,
  repoName,
  focused,
  expanded,
  index,
}: {
  readonly task: Task;
  readonly sprint: Sprint;
  readonly tasks: readonly Task[];
  readonly project: Project | undefined;
  readonly ticketTitle: string | undefined;
  readonly repoName: string | undefined;
  readonly focused: boolean;
  readonly expanded: boolean;
  readonly index: number;
}): React.JSX.Element => {
  const lastAttempt: Attempt | undefined = task.attempts[task.attempts.length - 1];
  const lastAttemptElapsed = lastAttempt !== undefined ? attemptElapsedMs(lastAttempt) : undefined;
  const { atLeast } = useBreakpoint();
  // At ≥md (≥100 cols) the metadata row stays on a single line and ellides on overflow so the
  // task card height stays a predictable two lines. Below md, the row is allowed to wrap so
  // narrow terminals don't lose information at the tail.
  const singleLineMetadata = atLeast('md');
  const metadataParts: readonly React.ReactNode[] = buildTaskMetadataParts({
    ticketTitle,
    dependsOnCount: task.dependsOn.length,
    repoName,
    attempts: task.attempts.length,
    maxAttempts: task.maxAttempts,
    lastAttemptElapsed,
  });
  return (
    <ListCard
      focused={focused}
      rightSlot={<StatusChip label={task.status} kind={taskStatusKind(task.status)} />}
      indexLabel={`#${String(index)}`}
      title={task.name}
    >
      {singleLineMetadata ? (
        <Box>
          <Text wrap="truncate-end" dimColor>
            {joinMetadataInline(metadataParts)}
          </Text>
        </Box>
      ) : (
        <Box flexWrap="wrap">
          {metadataParts.map((node, i) => (
            <Text key={`meta-${String(i)}`} dimColor>
              {i > 0 ? ' ' : ''}
              {node}
            </Text>
          ))}
        </Box>
      )}
      {!expanded && task.description !== undefined && <Description text={task.description} maxLines={2} />}
      {!expanded && task.status === 'blocked' && (
        <Box paddingLeft={2}>
          <Text color={inkColors.error}>
            {glyphs.cross} blocked: {task.blockedReason}
          </Text>
        </Box>
      )}
      {expanded && <TaskDetailBody task={task} sprint={sprint} tasks={tasks} project={project} />}
    </ListCard>
  );
};

interface TaskMetadataInput {
  readonly ticketTitle: string | undefined;
  readonly dependsOnCount: number;
  readonly repoName: string | undefined;
  readonly attempts: number;
  readonly maxAttempts: number | undefined;
  readonly lastAttemptElapsed: number | undefined;
}

/**
 * Build the per-field React nodes for the task metadata row. Each entry already carries its
 * leading bullet glyph (`·`); the caller decides whether to join them on one line (with an
 * intervening space) or render them as wrapped flex items.
 */
const buildTaskMetadataParts = (input: TaskMetadataInput): readonly React.ReactNode[] => {
  const parts: React.ReactNode[] = [];
  if (input.ticketTitle !== undefined) {
    parts.push(
      <React.Fragment key="ticket">
        {glyphs.bullet} ticket: <Text bold>{input.ticketTitle}</Text>
      </React.Fragment>
    );
  }
  if (input.dependsOnCount > 0) {
    parts.push(
      <React.Fragment key="deps">
        {glyphs.bullet} {String(input.dependsOnCount)} dep{input.dependsOnCount === 1 ? '' : 's'}
      </React.Fragment>
    );
  }
  if (input.repoName !== undefined) {
    parts.push(
      <React.Fragment key="repo">
        {glyphs.bullet} repo: <Text>{input.repoName}</Text>
      </React.Fragment>
    );
  }
  parts.push(
    <React.Fragment key="attempts">
      {glyphs.bullet} attempts: {String(input.attempts)}
      {input.maxAttempts !== undefined ? `/${String(input.maxAttempts)}` : ''}
    </React.Fragment>
  );
  if (input.lastAttemptElapsed !== undefined) {
    parts.push(
      <React.Fragment key="last">
        {glyphs.bullet} last: {fmtDuration(input.lastAttemptElapsed)}
      </React.Fragment>
    );
  }
  return parts;
};

const joinMetadataInline = (parts: readonly React.ReactNode[]): React.ReactNode =>
  parts.map((node, i) => (
    <React.Fragment key={`inline-${String(i)}`}>
      {i > 0 ? ' ' : ''}
      {node}
    </React.Fragment>
  ));

const repositoryName = (project: Project | undefined, id: RepositoryId): string | undefined => {
  if (project === undefined) return undefined;
  const repo = project.repositories.find((r) => r.id === id);
  return repo?.name;
};

const attemptElapsedMs = (attempt: Attempt): number | undefined => {
  if (attempt.status === 'running' || attempt.finishedAt === null) return undefined;
  const finished = Date.parse(attempt.finishedAt);
  const started = Date.parse(attempt.startedAt);
  return Number.isFinite(finished) && Number.isFinite(started) ? finished - started : undefined;
};

// ─── Detail bodies (inline-expanded card contents) ────────────────────────────────────────────

const TicketDetailBody = ({
  ticket,
  tasks,
}: {
  readonly ticket: Ticket;
  readonly tasks: readonly Task[];
}): React.JSX.Element => {
  const referencedTasks = tasks.filter((t) => t.ticketId === ticket.id);
  return (
    <Box flexDirection="column">
      {ticket.description !== undefined && (
        <Section heading="Description">
          <Description text={ticket.description} maxLines={Number.POSITIVE_INFINITY} />
        </Section>
      )}
      {ticket.status === 'approved' && (
        <Section heading="Requirements">
          <Description text={ticket.requirements} maxLines={Number.POSITIVE_INFINITY} />
        </Section>
      )}
      {referencedTasks.length > 0 && (
        <Section heading="Referenced tasks">
          <Box flexDirection="column" paddingLeft={2}>
            {referencedTasks.map((t) => (
              <Box key={t.id}>
                <StatusChip label={t.status} kind={taskStatusKind(t.status)} />
                <Text bold> {t.name}</Text>
              </Box>
            ))}
          </Box>
        </Section>
      )}
    </Box>
  );
};

const TaskDetailBody = ({
  task,
  sprint,
  tasks,
  project,
}: {
  readonly task: Task;
  readonly sprint: Sprint;
  readonly tasks: readonly Task[];
  readonly project: Project | undefined;
}): React.JSX.Element => {
  const ticket = sprint.tickets.find((t) => t.id === task.ticketId);
  const dependsOnTasks = task.dependsOn
    .map((id): Task | undefined => tasks.find((t) => t.id === id))
    .filter((t): t is Task => t !== undefined);
  const repoName = repositoryName(project, task.repositoryId);
  return (
    <Box flexDirection="column">
      <FieldList
        fields={[
          { label: 'Order', value: String(task.order) },
          {
            label: 'Repository',
            value: repoName !== undefined ? `${repoName}  (${String(task.repositoryId)})` : String(task.repositoryId),
          },
          {
            label: 'Ticket',
            value: ticket !== undefined ? `${ticket.title}  [${ticket.status}]` : String(task.ticketId),
          },
          ...(task.status === 'done' ? [{ label: 'Final attempt', value: `#${String(task.finalAttemptN)}` }] : []),
          ...(task.extraDimensions !== undefined && task.extraDimensions.length > 0
            ? [{ label: 'Extra dims', value: task.extraDimensions.join(', ') }]
            : []),
        ]}
      />
      {task.status === 'blocked' && (
        <Box marginTop={1}>
          <Text color={inkColors.error}>
            {glyphs.cross} blocked: {task.blockedReason}
          </Text>
        </Box>
      )}
      {task.description !== undefined && (
        <Section heading="Description">
          <Description text={task.description} maxLines={Number.POSITIVE_INFINITY} />
        </Section>
      )}
      {task.steps.length > 0 && (
        <Section heading="Steps">
          <Box flexDirection="column" paddingLeft={2}>
            {task.steps.map((s, i) => (
              <Text key={`step-${String(i)}`} dimColor>
                {String(i + 1)}. {s}
              </Text>
            ))}
          </Box>
        </Section>
      )}
      {task.verificationCriteria.length > 0 && (
        <Section heading="Verification">
          <Box flexDirection="column" paddingLeft={2}>
            {task.verificationCriteria.map((c, i) => (
              <Text key={`vc-${String(i)}`} dimColor>
                {glyphs.bullet} [{c.id}] {c.check}
                {c.check === 'auto' && c.command !== undefined ? ` \`${c.command}\`` : ''} — {c.assertion}
              </Text>
            ))}
          </Box>
        </Section>
      )}
      {dependsOnTasks.length > 0 && (
        <Section heading="Depends on">
          <Box flexDirection="column" paddingLeft={2}>
            {dependsOnTasks.map((d) => (
              <Box key={d.id}>
                <StatusChip label={d.status} kind={taskStatusKind(d.status)} />
                <Text bold> {d.name}</Text>
              </Box>
            ))}
          </Box>
        </Section>
      )}
      {task.attempts.length > 0 && (
        <Section heading="Attempt history">
          <Box flexDirection="column" paddingLeft={2}>
            {task.attempts.map((attempt) => (
              <AttemptCard key={`attempt-${String(attempt.n)}`} attempt={attempt} />
            ))}
          </Box>
        </Section>
      )}
    </Box>
  );
};

const AttemptCard = ({ attempt }: { readonly attempt: Attempt }): React.JSX.Element => {
  const elapsedMs = attemptElapsedMs(attempt);
  return (
    <Box flexDirection="column" marginBottom={1} paddingLeft={1}>
      <Box>
        <Text bold>#{String(attempt.n)}</Text>
        <Text> </Text>
        <StatusChip label={attempt.status} kind={attemptStatusKind(attempt.status)} />
        <Text dimColor>
          {' '}
          {glyphs.bullet} started {fmtIsoAbsolute(attempt.startedAt)}
        </Text>
        {attempt.finishedAt !== null && (
          <Text dimColor>
            {' '}
            {glyphs.bullet} finished {fmtIsoAbsolute(attempt.finishedAt)}
          </Text>
        )}
        {elapsedMs !== undefined && (
          <Text dimColor>
            {' '}
            {glyphs.bullet} elapsed {fmtDuration(elapsedMs)}
          </Text>
        )}
      </Box>
      <Box paddingLeft={2} flexDirection="column">
        {attempt.sessionId !== undefined && (
          <Text dimColor>
            session: <Text>{attempt.sessionId}</Text>
          </Text>
        )}
        {attempt.commitSha !== undefined && (
          <Text dimColor>
            commit: <Text>{String(attempt.commitSha)}</Text>
          </Text>
        )}
        {attempt.evaluation !== undefined && (
          <Text dimColor>
            evaluation: <Text color={evaluationColor(attempt.evaluation.status)}>{attempt.evaluation.status}</Text>{' '}
            <Text dimColor>({attempt.evaluation.file})</Text>
          </Text>
        )}
        {attempt.warning !== undefined && (
          <Text color={inkColors.warning}>
            {glyphs.warningGlyph} {attempt.warning.kind}
            {renderWarningDetail(attempt.warning)}
          </Text>
        )}
        {attempt.critique !== undefined && (
          <Box paddingLeft={1}>
            <Text dimColor italic>
              critique: {firstLine(attempt.critique)}
            </Text>
          </Box>
        )}
      </Box>
    </Box>
  );
};

const attemptStatusKind = (status: Attempt['status']): StatusKind => {
  switch (status) {
    case 'running':
      return 'info';
    case 'verified':
      return 'success';
    case 'failed':
      return 'error';
    case 'malformed':
      return 'error';
    case 'aborted':
      return 'warning';
  }
};

const evaluationColor = (status: 'passed' | 'failed' | 'malformed'): string => {
  switch (status) {
    case 'passed':
      return inkColors.success;
    case 'failed':
      return inkColors.error;
    case 'malformed':
      return inkColors.warning;
  }
};

/**
 * Human-readable detail tail for an attempt warning. The base label (`budget-exhausted`,
 * `plateau`, …) is rendered by the caller; this returns the suffix (` · 5/5 turns`, etc.).
 */
const renderWarningDetail = (w: NonNullable<Attempt['warning']>): string => {
  switch (w.kind) {
    case 'budget-exhausted':
      return `  ${glyphs.bullet} ${String(w.turnsUsed)}/${String(w.turnBudget)} turns`;
    case 'plateau':
      return w.dimensions.length > 0 ? `  ${glyphs.bullet} ${w.dimensions.join(', ')}` : '';
    case 'malformed':
      return `  ${glyphs.bullet} ${firstLine(w.detail)}`;
    case 'verify-failed':
      return `  ${glyphs.bullet} exit ${String(w.exitCode ?? '?')}${w.stderr.length > 0 ? ` · ${firstLine(w.stderr)}` : ''}`;
  }
};

const firstLine = (s: string): string => {
  const line = s.split('\n').find((l) => l.trim().length > 0) ?? '';
  return line.length > 120 ? `${line.slice(0, 119)}${glyphs.clipEllipsis}` : line;
};

// ─── Shared bits ──────────────────────────────────────────────────────────────────────────────

const DESCRIPTION_MAX_LINES = 3;

const Section = ({
  heading,
  children,
}: {
  readonly heading: string;
  readonly children: React.ReactNode;
}): React.JSX.Element => (
  <Box flexDirection="column" marginTop={1}>
    <Text bold dimColor>
      {glyphs.bullet} {heading}
    </Text>
    <Box marginTop={0}>{children}</Box>
  </Box>
);

/**
 * Description block — markdown-light: strips `**bold**` markers and bullet prefixes so the
 * source string renders cleanly inside a TUI. Caps visible lines unless the caller passes
 * `Number.POSITIVE_INFINITY` (detail view wants the whole text).
 */
const Description = ({
  text,
  maxLines = DESCRIPTION_MAX_LINES,
}: {
  readonly text: string;
  readonly maxLines?: number;
}): React.JSX.Element | null => {
  const lines = text
    .split('\n')
    .map((line) =>
      line
        .replace(/\*\*(.+?)\*\*/g, '$1')
        .replace(/^\s*[-*]\s+/, '')
        .trimEnd()
    )
    .filter((line) => line.trim().length > 0);
  if (lines.length === 0) return null;
  const shown = Number.isFinite(maxLines) ? lines.slice(0, maxLines) : lines;
  const hidden = lines.length - shown.length;
  return (
    <Box flexDirection="column" paddingLeft={2}>
      {shown.map((line, idx) => (
        <Text key={`${String(idx)}:${line.slice(0, 16)}`} dimColor>
          {line}
        </Text>
      ))}
      {hidden > 0 && (
        <Text dimColor>
          {glyphs.bullet} +{String(hidden)} more line{hidden === 1 ? '' : 's'}
        </Text>
      )}
    </Box>
  );
};
