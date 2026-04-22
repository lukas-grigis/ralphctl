/**
 * TaskListView — scrollable table of tasks in a sprint.
 *
 * Accepts an optional `sprintId` prop. Falls back to the current sprint
 * when no id is supplied. `f` cycles a status filter (`all → todo →
 * active → done → all`, where "active" maps to `in_progress`).
 */

import React, { useEffect, useMemo, useState } from 'react';
import { useInput } from 'ink';
import type { Project, Task } from '@src/domain/models.ts';
import { getSprint, resolveSprintId } from '@src/integration/persistence/sprint.ts';
import { listTasks } from '@src/integration/persistence/task.ts';
import { listProjects } from '@src/integration/persistence/project.ts';
import { inkColors } from '@src/integration/ui/theme/tokens.ts';
import { ListView, type ListColumn } from '@src/integration/ui/tui/components/list-view.tsx';
import { Spinner } from '@src/integration/ui/tui/components/spinner.tsx';
import { ResultCard } from '@src/integration/ui/tui/components/result-card.tsx';
import { ViewShell } from '@src/integration/ui/tui/components/view-shell.tsx';
import { useViewHints } from '@src/integration/ui/tui/views/view-hints-context.tsx';
import { useRouter } from '@src/integration/ui/tui/views/router-context.ts';

interface Props {
  readonly sprintId?: string;
}

type Filter = 'all' | 'todo' | 'active' | 'done';

const FILTER_CYCLE: readonly Filter[] = ['all', 'todo', 'active', 'done'] as const;

function nextFilter(f: Filter): Filter {
  const i = FILTER_CYCLE.indexOf(f);
  return FILTER_CYCLE[(i + 1) % FILTER_CYCLE.length] ?? 'all';
}

function matches(task: Task, filter: Filter): boolean {
  if (filter === 'all') return true;
  if (filter === 'active') return task.status === 'in_progress';
  return task.status === filter;
}

interface ReadyState {
  readonly kind: 'ready';
  readonly tasks: readonly Task[];
  readonly repoNamesById: ReadonlyMap<string, string>;
  readonly ticketTitlesById: ReadonlyMap<string, string>;
}

type State = { kind: 'loading' } | { kind: 'empty' } | ReadyState | { kind: 'error'; message: string };

function statusColor(status: Task['status']): string {
  if (status === 'done') return inkColors.success;
  if (status === 'in_progress') return inkColors.warning;
  return inkColors.muted;
}

function evaluationBadge(task: Task): string {
  if (!task.evaluationStatus) return '—';
  const map: Record<NonNullable<Task['evaluationStatus']>, string> = {
    passed: 'passed',
    failed: 'failed',
    malformed: 'malformed',
    plateau: 'plateau',
  };
  return map[task.evaluationStatus];
}

function evaluationColor(task: Task): string | undefined {
  if (!task.evaluationStatus) return undefined;
  if (task.evaluationStatus === 'passed') return inkColors.success;
  if (task.evaluationStatus === 'failed') return inkColors.error;
  return inkColors.warning;
}

function buildColumns(
  repoNamesById: ReadonlyMap<string, string>,
  ticketTitlesById: ReadonlyMap<string, string>
): readonly ListColumn<Task>[] {
  return [
    {
      header: 'Status',
      cell: (t) => `[${t.status.replace('_', ' ').toUpperCase()}]`,
      width: 14,
      color: (t) => statusColor(t.status),
    },
    { header: '#', cell: (t) => String(t.order), align: 'right', width: 3 },
    { header: 'Name', cell: (t) => t.name, flex: true },
    {
      header: 'Repo',
      cell: (t) => repoNamesById.get(t.repoId) ?? t.repoId,
      width: 14,
    },
    {
      header: 'Ticket',
      cell: (t) => (t.ticketId ? (ticketTitlesById.get(t.ticketId) ?? t.ticketId) : '—'),
      width: 18,
    },
    {
      header: 'Eval',
      cell: evaluationBadge,
      width: 10,
      color: evaluationColor,
    },
  ];
}

const TITLE_BASE = 'Tasks' as const;
const HINTS_READY = [
  { key: '↑/↓', action: 'navigate' },
  { key: 'Enter', action: 'open' },
  { key: 'f', action: 'filter' },
  { key: 'a', action: 'add' },
  { key: 't', action: 'status' },
  { key: 'r', action: 'remove' },
] as const;
const HINTS_EMPTY = [{ key: 'a', action: 'add' }] as const;

export function TaskListView({ sprintId }: Props): React.JSX.Element {
  const router = useRouter();
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [filter, setFilter] = useState<Filter>('all');
  useViewHints(state.kind === 'ready' ? HINTS_READY : HINTS_EMPTY);

  useEffect(() => {
    const ctl = { cancelled: false };
    void (async () => {
      try {
        const id = await resolveSprintId(sprintId);
        const [sprint, tasks, projects] = await Promise.all([getSprint(id), listTasks(id), listProjects()]);
        if (ctl.cancelled) return;
        if (tasks.length === 0) {
          setState({ kind: 'empty' });
          return;
        }
        const repoNamesById = new Map<string, string>();
        for (const p of projects as readonly Project[]) {
          for (const r of p.repositories) repoNamesById.set(r.id, r.name);
        }
        const ticketTitlesById = new Map<string, string>();
        for (const t of sprint.tickets) {
          ticketTitlesById.set(t.id, t.title);
        }
        setState({ kind: 'ready', tasks, repoNamesById, ticketTitlesById });
      } catch (err) {
        if (ctl.cancelled) return;
        setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
      }
    })();
    return () => {
      ctl.cancelled = true;
    };
  }, [sprintId]);

  useInput((input) => {
    if (state.kind === 'loading') return;
    if (input === 'a') {
      router.push({ id: 'task-add' });
      return;
    }
    if (state.kind !== 'ready') return;
    if (input === 'f') {
      setFilter(nextFilter);
      return;
    }
    if (input === 't') {
      router.push({ id: 'task-status' });
      return;
    }
    if (input === 'r') {
      router.push({ id: 'task-remove' });
    }
  });

  const filtered = useMemo<readonly Task[]>(() => {
    if (state.kind !== 'ready') return [];
    if (filter === 'all') return state.tasks;
    return state.tasks.filter((t) => matches(t, filter));
  }, [state, filter]);

  const title = filter === 'all' ? TITLE_BASE : `${TITLE_BASE} · filter: ${filter}`;

  return (
    <ViewShell title={title}>
      {state.kind === 'loading' ? (
        <Spinner label="Loading tasks…" />
      ) : state.kind === 'empty' ? (
        <ResultCard kind="info" title="No tasks in this sprint" />
      ) : state.kind === 'error' ? (
        <ResultCard kind="error" title="Could not load tasks" lines={[state.message]} />
      ) : filtered.length === 0 ? (
        <ResultCard kind="info" title={`No tasks with filter '${filter}'`} lines={['Press f to cycle the filter.']} />
      ) : (
        <ListView<Task>
          rows={filtered}
          columns={buildColumns(state.repoNamesById, state.ticketTitlesById)}
          onSelect={(t) => {
            router.push({ id: 'task-show', props: { taskId: t.id } });
          }}
        />
      )}
    </ViewShell>
  );
}
