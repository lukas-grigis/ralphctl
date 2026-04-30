/**
 * TaskListView — browse tasks for the current sprint, ordered by task.order.
 *
 * Loads currentSprint from config. Press Enter to see task detail inline.
 *
 * Keyboard: ↑/↓ navigate · Enter expand/collapse inline detail · Esc back
 */

import React, { useEffect, useState } from 'react';
import { Box, useInput } from 'ink';
import { inkColors, spacing } from '../../../../integration/ui/theme/tokens.ts';
import { ViewShell } from '../../components/view-shell.tsx';
import { ListView, type ListColumn } from '../../components/list-view.tsx';
import { ResultCard } from '../../components/result-card.tsx';
import { Spinner } from '../../components/spinner.tsx';
import { chipKindForTaskStatus } from '../../components/status-chip.tsx';
import { useViewHints } from '../view-hints-context.tsx';
import { useRouterOptional } from '../router-context.ts';
import { getSharedDeps } from '../../../bootstrap/get-shared-deps.ts';
import { ListTasksUseCase } from '../../../../business/usecases/task/list-tasks.ts';
import { SprintId } from '../../../../domain/values/sprint-id.ts';
import { getKeyFor } from '../../keyboard-map.ts';
import type { Task } from '../../../../domain/entities/task.ts';

type TaskFilter = 'all' | 'todo' | 'in_progress' | 'done';
const TASK_FILTERS: readonly TaskFilter[] = ['all', 'todo', 'in_progress', 'done'];

const LIST_HINTS = [
  { key: '↑/↓', action: 'navigate' },
  { key: 'Enter', action: 'expand/collapse' },
  { key: getKeyFor('list.add'), action: 'add' },
  { key: getKeyFor('list.edit'), action: 'edit' },
  { key: getKeyFor('list.status'), action: 'change status' },
  { key: getKeyFor('list.remove'), action: 'remove' },
  { key: getKeyFor('list.filter'), action: 'cycle filter' },
] as const;

const COLUMNS: readonly ListColumn<Task>[] = [
  {
    header: '#',
    cell: (t) => String(t.order),
    width: 3,
    align: 'right',
  },
  {
    header: 'STATUS',
    cell: (t) => t.status.replace('_', ' ').toUpperCase(),
    width: 11,
    color: (t) => {
      const kind = chipKindForTaskStatus(t.status);
      if (kind === 'success') return inkColors.success;
      if (kind === 'warning') return inkColors.warning;
      if (kind === 'error') return inkColors.error;
      return inkColors.muted;
    },
  },
  {
    header: 'NAME',
    cell: (t) => t.name,
    flex: true,
  },
];

interface TaskDetailProps {
  readonly task: Task;
}

function TaskDetail({ task }: TaskDetailProps): React.JSX.Element {
  const fields: [string, string][] = [
    ['ID', String(task.id)],
    ['Order', String(task.order)],
    ['Status', task.status.replace('_', ' ').toUpperCase()],
    ['Project', String(task.projectPath)],
    ['Verified', task.verified ? 'yes' : 'no'],
    ['Evaluated', task.evaluated ? 'yes' : 'no'],
    ...(task.ticketId !== undefined ? [['Ticket', String(task.ticketId)] as [string, string]] : []),
  ];
  return (
    <Box marginTop={spacing.section} flexDirection="column">
      <ResultCard
        kind="info"
        title={task.name}
        fields={fields}
        lines={task.description !== undefined ? [task.description] : []}
      />
    </Box>
  );
}

export function TaskListView(): React.JSX.Element {
  useViewHints(LIST_HINTS);
  const router = useRouterOptional();
  const [tasks, setTasks] = useState<readonly Task[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Task | null>(null);
  const [cursor, setCursor] = useState(0);
  const [filter, setFilter] = useState<TaskFilter>('all');

  useEffect(() => {
    const cancel = { current: false };
    void (async () => {
      try {
        const deps = await getSharedDeps();
        const config = await deps.configStore.load();
        if (!config.ok) {
          setError(config.error.message);
          return;
        }
        const sprintIdStr = config.value.currentSprint;
        if (!sprintIdStr) {
          setError('No current sprint. Set one via Settings.');
          return;
        }
        const idResult = SprintId.parse(sprintIdStr);
        if (!idResult.ok) {
          setError(idResult.error.message);
          return;
        }
        const uc = new ListTasksUseCase(deps.taskRepo);
        const result = await uc.execute({ sprintId: idResult.value });
        if (cancel.current) return;
        if (!result.ok) {
          setError(result.error.message);
          return;
        }
        const sorted = [...result.value].sort((a, b) => a.order - b.order);
        setTasks(sorted);
      } catch (err) {
        if (!cancel.current) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancel.current = true;
    };
  }, []);

  const visible = tasks === null ? null : filter === 'all' ? tasks : tasks.filter((t) => t.status === filter);

  const KEY_ADD = getKeyFor('list.add');
  const KEY_EDIT = getKeyFor('list.edit');
  const KEY_FILTER = getKeyFor('list.filter');
  const KEY_STATUS = getKeyFor('list.status');
  const KEY_REMOVE = getKeyFor('list.remove');

  useInput((input) => {
    if (input === KEY_ADD) {
      router?.push({ id: 'task-add' });
      return;
    }
    if (input === KEY_EDIT) {
      const task = visible?.[cursor];
      if (!task) return;
      router?.push({ id: 'task-edit', props: { taskId: String(task.id) } });
      return;
    }
    if (input === KEY_FILTER) {
      setFilter((f) => {
        const idx = TASK_FILTERS.indexOf(f);
        return TASK_FILTERS[(idx + 1) % TASK_FILTERS.length] ?? 'all';
      });
      return;
    }
    if (input === KEY_STATUS) {
      const task = visible?.[cursor];
      if (!task) return;
      router?.push({ id: 'task-edit-status', props: { taskId: String(task.id) } });
      return;
    }
    if (input === KEY_REMOVE) {
      const task = visible?.[cursor];
      if (!task) return;
      router?.push({ id: 'task-remove', props: { taskId: String(task.id) } });
    }
  });

  const filterLabel = filter !== 'all' ? ` [${filter.replace('_', ' ')}]` : '';

  return (
    <ViewShell title={`TASKS${filterLabel}`}>
      <Box flexDirection="column">
        {tasks === null && error === null ? (
          <Spinner label="Loading tasks…" />
        ) : error !== null ? (
          <ResultCard kind="error" title="Failed to load tasks" lines={[error]} />
        ) : visible !== null && visible.length === 0 ? (
          <ResultCard
            kind="info"
            title={filter !== 'all' ? `No ${filter.replace('_', ' ')} tasks.` : 'No tasks in current sprint.'}
            nextSteps={[
              { action: 'Add a task', description: `press '${KEY_ADD}'` },
              { action: 'Or run sprint plan', description: 'to generate tasks via AI' },
            ]}
          />
        ) : (
          <>
            <ListView
              rows={visible ?? []}
              columns={COLUMNS}
              onSelect={(t, idx) => {
                setCursor(idx);
                setSelected(t === selected ? null : t);
              }}
              emptyLabel="No tasks"
              initialCursor={cursor}
              onCursorChange={(_, idx) => {
                setCursor(idx);
              }}
            />
            {selected !== null ? <TaskDetail task={selected} /> : null}
          </>
        )}
      </Box>
    </ViewShell>
  );
}
