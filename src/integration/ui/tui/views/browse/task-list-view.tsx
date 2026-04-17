/**
 * TaskListView — scrollable table of tasks in the current sprint.
 */

import React, { useEffect, useState } from 'react';
import type { Task } from '@src/domain/models.ts';
import { listTasks } from '@src/integration/persistence/task.ts';
import { inkColors } from '@src/integration/ui/theme/tokens.ts';
import { ListView, type ListColumn } from '@src/integration/ui/tui/components/list-view.tsx';
import { Spinner } from '@src/integration/ui/tui/components/spinner.tsx';
import { ResultCard } from '@src/integration/ui/tui/components/result-card.tsx';
import { ViewShell } from '@src/integration/ui/tui/components/view-shell.tsx';
import { useViewHints } from '@src/integration/ui/tui/views/view-hints-context.tsx';
import { useRouter } from '@src/integration/ui/tui/views/router-context.ts';

type State = { kind: 'loading' } | { kind: 'empty' } | { kind: 'ready'; tasks: Task[] } | { kind: 'error'; message: string };

function statusColor(status: Task['status']): string {
  if (status === 'done') return inkColors.success;
  if (status === 'in_progress') return inkColors.warning;
  return inkColors.muted;
}

const COLUMNS: readonly ListColumn<Task>[] = [
  { header: '#', cell: (t) => String(t.order), align: 'right', width: 3 },
  { header: 'ID', cell: (t) => t.id, width: 10 },
  { header: 'Name', cell: (t) => t.name, flex: true },
  { header: 'Status', cell: (t) => t.status, width: 11, color: (t) => statusColor(t.status) },
];

const TITLE = 'Tasks' as const;
const HINTS = [
  { key: '↑/↓', action: 'navigate' },
  { key: 'Enter', action: 'open' },
] as const;

export function TaskListView(): React.JSX.Element {
  const router = useRouter();
  const [state, setState] = useState<State>({ kind: 'loading' });
  useViewHints(HINTS);

  useEffect(() => {
    const ctl = { cancelled: false };
    void (async () => {
      try {
        const tasks = await listTasks();
        if (ctl.cancelled) return;
        if (tasks.length === 0) setState({ kind: 'empty' });
        else setState({ kind: 'ready', tasks });
      } catch (err) {
        if (ctl.cancelled) return;
        setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
      }
    })();
    return () => {
      ctl.cancelled = true;
    };
  }, []);

  return (
    <ViewShell title={TITLE}>
      {state.kind === 'loading' ? (
        <Spinner label="Loading tasks…" />
      ) : state.kind === 'empty' ? (
        <ResultCard kind="info" title="No tasks in this sprint" />
      ) : state.kind === 'error' ? (
        <ResultCard kind="error" title="Could not load tasks" lines={[state.message]} />
      ) : (
        <ListView<Task>
          rows={state.tasks}
          columns={COLUMNS}
          onSelect={(t) => {
            router.push({ id: 'task-show', props: { taskId: t.id } });
          }}
        />
      )}
    </ViewShell>
  );
}
