/**
 * SprintListView — scrollable table of every sprint. Enter drills into the
 * corresponding sprint hub (sprint-show). `f` cycles a status filter.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { useInput } from 'ink';
import type { Project, Sprint, SprintStatus, Tasks } from '@src/domain/models.ts';
import { listSprints } from '@src/integration/persistence/sprint.ts';
import { listProjects } from '@src/integration/persistence/project.ts';
import { getTasks } from '@src/integration/persistence/task.ts';
import { inkColors } from '@src/integration/ui/theme/tokens.ts';
import { ListView, type ListColumn } from '@src/integration/ui/tui/components/list-view.tsx';
import { Spinner } from '@src/integration/ui/tui/components/spinner.tsx';
import { ResultCard } from '@src/integration/ui/tui/components/result-card.tsx';
import {
  chipKindForSprintStatus,
  type StatusKind,
} from '@src/integration/ui/tui/components/status-chip.tsx';
import { ViewShell } from '@src/integration/ui/tui/components/view-shell.tsx';
import { useViewHints } from '@src/integration/ui/tui/views/view-hints-context.tsx';
import { useRouter } from '@src/integration/ui/tui/views/router-context.ts';

type Filter = 'all' | SprintStatus;

interface TaskCounts {
  readonly total: number;
  readonly done: number;
}

interface ReadyState {
  readonly kind: 'ready';
  readonly sprints: readonly Sprint[];
  readonly projectsById: ReadonlyMap<string, Project>;
  readonly taskCountsById: ReadonlyMap<string, TaskCounts>;
}

type State =
  | { kind: 'loading' }
  | { kind: 'empty' }
  | ReadyState
  | { kind: 'error'; message: string };

// A StatusChip inside a ListView cell would break the padding math — the cell
// function must return a plain string — so we render the chip label in-band
// using the column's color and bracket the label ourselves.
function statusChipText(status: SprintStatus): string {
  return `[${status.toUpperCase()}]`;
}

function statusColor(kind: StatusKind): string {
  const map: Record<StatusKind, string> = {
    info: inkColors.info,
    success: inkColors.success,
    warning: inkColors.warning,
    error: inkColors.error,
    muted: inkColors.muted,
  };
  return map[kind];
}

function buildColumns(
  projectsById: ReadonlyMap<string, Project>,
  taskCountsById: ReadonlyMap<string, TaskCounts>
): readonly ListColumn<Sprint>[] {
  return [
    {
      header: 'Status',
      cell: (s) => statusChipText(s.status),
      color: (s) => statusColor(chipKindForSprintStatus(s.status)),
      width: 10,
    },
    { header: 'Name', cell: (s) => s.name, flex: true },
    {
      header: 'Project',
      cell: (s) => projectsById.get(s.projectId)?.name ?? s.projectId,
      width: 16,
    },
    {
      header: 'Created',
      cell: (s) => s.createdAt.slice(0, 10),
      width: 10,
    },
    {
      header: 'Tickets',
      cell: (s) => String(s.tickets.length),
      align: 'right',
      width: 7,
    },
    {
      header: 'Tasks',
      cell: (s) => {
        const c = taskCountsById.get(s.id);
        if (!c) return '—';
        return `${String(c.done)}/${String(c.total)}`;
      },
      align: 'right',
      width: 7,
    },
  ];
}

const TITLE_BASE = 'Sprints' as const;
const HINTS_READY = [
  { key: '↑/↓', action: 'navigate' },
  { key: 'Enter', action: 'open' },
  { key: 'f', action: 'filter' },
  { key: 'n', action: 'new' },
  { key: 'c', action: 'set current' },
  { key: 'x', action: 'delete' },
] as const;
const HINTS_EMPTY = [{ key: 'n', action: 'new' }] as const;

const FILTER_CYCLE: readonly Filter[] = ['all', 'draft', 'active', 'closed'] as const;

function nextFilter(current: Filter): Filter {
  const idx = FILTER_CYCLE.indexOf(current);
  return FILTER_CYCLE[(idx + 1) % FILTER_CYCLE.length] ?? 'all';
}

export function SprintListView(): React.JSX.Element {
  const router = useRouter();
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [filter, setFilter] = useState<Filter>('all');
  useViewHints(state.kind === 'ready' ? HINTS_READY : HINTS_EMPTY);

  useEffect(() => {
    const ctl: { cancelled: boolean } = { cancelled: false };
    void (async () => {
      try {
        const [sprints, projects] = await Promise.all([listSprints(), listProjects()]);
        if (sprints.length === 0) {
          if (ctl.cancelled) return;
          setState({ kind: 'empty' });
          return;
        }
        const projectsById = new Map(projects.map((p) => [p.id, p]));
        const taskCountsById = new Map<string, TaskCounts>();
        await Promise.all(
          sprints.map(async (s) => {
            try {
              const tasks: Tasks = await getTasks(s.id);
              taskCountsById.set(s.id, {
                total: tasks.length,
                done: tasks.filter((t) => t.status === 'done').length,
              });
            } catch {
              taskCountsById.set(s.id, { total: 0, done: 0 });
            }
          })
        );
        if (ctl.cancelled) return;
        setState({ kind: 'ready', sprints, projectsById, taskCountsById });
      } catch (err) {
        if (ctl.cancelled) return;
        setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
      }
    })();
    return () => {
      ctl.cancelled = true;
    };
  }, []);

  useInput((input) => {
    if (state.kind === 'loading') return;
    if (input === 'n') {
      router.push({ id: 'sprint-create' });
      return;
    }
    if (state.kind !== 'ready') return;
    if (input === 'f') {
      setFilter(nextFilter);
      return;
    }
    if (input === 'c') {
      router.push({ id: 'sprint-set-current' });
      return;
    }
    if (input === 'x') {
      router.push({ id: 'sprint-delete' });
    }
  });

  const title = filter === 'all' ? TITLE_BASE : `${TITLE_BASE} · filter: ${filter}`;

  const filtered = useMemo<readonly Sprint[]>(() => {
    if (state.kind !== 'ready') return [];
    if (filter === 'all') return state.sprints;
    return state.sprints.filter((s) => s.status === filter);
  }, [state, filter]);

  return (
    <ViewShell title={title}>
      {state.kind === 'loading' ? (
        <Spinner label="Loading sprints…" />
      ) : state.kind === 'empty' ? (
        <ResultCard kind="info" title="No sprints yet" lines={['Press `n` to create one.']} />
      ) : state.kind === 'error' ? (
        <ResultCard kind="error" title="Could not load sprints" lines={[state.message]} />
      ) : filtered.length === 0 ? (
        <ResultCard
          kind="info"
          title={`No sprints with status '${filter}'`}
          lines={['Press f to cycle the filter.']}
        />
      ) : (
        <ListView<Sprint>
          rows={filtered}
          columns={buildColumns(state.projectsById, state.taskCountsById)}
          onSelect={(s) => {
            router.push({ id: 'sprint-show', props: { sprintId: s.id } });
          }}
          emptyLabel="No sprints"
        />
      )}
    </ViewShell>
  );
}
