/**
 * TaskListView — browse tasks for the current sprint, ordered by task.order.
 *
 * Loads currentSprint from config. Press Enter to see task detail inline.
 *
 * Keyboard: ↑/↓ navigate · Enter expand/collapse inline detail · Esc back
 */

import React, { useState } from 'react';
import { useViewInput } from '@src/application/tui/views/use-view-input.ts';
import { Box } from 'ink';
import { inkColors, spacing } from '@src/integration/ui/theme/tokens.ts';
import { ViewShell } from '@src/application/tui/components/view-shell.tsx';
import { ListView, type ListColumn } from '@src/application/tui/components/list-view.tsx';
import { ResultCard } from '@src/application/tui/components/result-card.tsx';
import { Spinner } from '@src/application/tui/components/spinner.tsx';
import { useAsyncLoad } from '@src/application/tui/components/use-async-load.ts';
import { resolveCurrentSprintId } from '@src/application/tui/components/resolve-current-sprint.ts';
import { chipKindForTaskStatus } from '@src/application/tui/components/status-chip.tsx';
import { useViewHints } from '@src/application/tui/views/view-hints-context.tsx';
import { useRouterOptional } from '@src/application/tui/views/router-context.ts';
import { getSharedDeps } from '@src/application/bootstrap/get-shared-deps.ts';
import { ListTasksUseCase } from '@src/business/usecases/task/list-tasks.ts';
import { getKeyFor } from '@src/application/tui/keyboard-map.ts';
import type { Task } from '@src/domain/entities/task.ts';

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
  const { data: tasks, error } = useAsyncLoad<readonly Task[]>(async () => {
    const deps = await getSharedDeps();
    const idResult = await resolveCurrentSprintId(deps.configStore);
    if (!idResult.ok) throw new Error(idResult.error.message);
    const uc = new ListTasksUseCase(deps.taskRepo);
    const result = await uc.execute({ sprintId: idResult.value });
    if (!result.ok) throw new Error(result.error.message);
    return [...result.value].sort((a, b) => a.order - b.order);
  });
  const [selected, setSelected] = useState<Task | null>(null);
  const [cursor, setCursor] = useState(0);
  const [filter, setFilter] = useState<TaskFilter>('all');

  const visible = tasks === null ? null : filter === 'all' ? tasks : tasks.filter((t) => t.status === filter);

  const KEY_ADD = getKeyFor('list.add');
  const KEY_EDIT = getKeyFor('list.edit');
  const KEY_FILTER = getKeyFor('list.filter');
  const KEY_STATUS = getKeyFor('list.status');
  const KEY_REMOVE = getKeyFor('list.remove');

  useViewInput((input) => {
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
