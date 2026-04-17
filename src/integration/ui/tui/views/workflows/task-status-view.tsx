/**
 * TaskStatusView — native Ink flow for `task status`.
 *
 * Pick a task → pick a new status → persist. Only works on an active sprint
 * (per `updateTaskStatus` assertion).
 */

import React, { useMemo } from 'react';
import type { Task, TaskStatus } from '@src/domain/models.ts';
import { getPrompt } from '@src/integration/bootstrap.ts';
import { getCurrentSprintOrThrow } from '@src/integration/persistence/sprint.ts';
import { listTasks, updateTaskStatus } from '@src/integration/persistence/task.ts';
import { ResultCard } from '@src/integration/ui/tui/components/result-card.tsx';
import { Spinner } from '@src/integration/ui/tui/components/spinner.tsx';
import { ViewShell } from '@src/integration/ui/tui/components/view-shell.tsx';
import { useViewHints } from '@src/integration/ui/tui/views/view-hints-context.tsx';
import { useWorkflow } from './use-workflow.ts';

const TITLE = 'Task Status' as const;

const HINTS_RUNNING = [{ key: 'Esc', action: 'cancel' }] as const;
const HINTS_DONE = [
  { key: 'Enter', action: 'home' },
  { key: 'Esc', action: 'back' },
] as const;

type Phase =
  | { kind: 'running'; step: 'select-task' | 'select-status' | 'saving' }
  | { kind: 'no-tasks' }
  | { kind: 'not-active' }
  | { kind: 'done'; task: Task }
  | { kind: 'error'; message: string };

export function TaskStatusView(): React.JSX.Element {
  const { phase } = useWorkflow<Phase>({
    initial: { kind: 'running', step: 'select-task' },
    onError: (message) => ({ kind: 'error', message }),
    run: async ({ setPhase }) => {
      const prompt = getPrompt();

      const sprint = await getCurrentSprintOrThrow();
      if (sprint.status !== 'active') {
        setPhase({ kind: 'not-active' });
        return;
      }

      const tasks = await listTasks();
      if (tasks.length === 0) {
        setPhase({ kind: 'no-tasks' });
        return;
      }

      setPhase({ kind: 'running', step: 'select-task' });
      const taskId = await prompt.select<string>({
        message: 'Select task:',
        choices: tasks.map((t) => ({
          label: `${t.id} — ${t.name}`,
          value: t.id,
          description: `${t.status} · order ${String(t.order)}`,
        })),
      });

      setPhase({ kind: 'running', step: 'select-status' });
      const nextStatus = await prompt.select<TaskStatus>({
        message: 'New status:',
        choices: [
          { label: 'To Do', value: 'todo' },
          { label: 'In Progress', value: 'in_progress' },
          { label: 'Done', value: 'done' },
        ],
      });

      setPhase({ kind: 'running', step: 'saving' });
      const task = await updateTaskStatus(taskId, nextStatus);
      setPhase({ kind: 'done', task });
    },
  });

  const hints = useMemo(() => (phase.kind === 'running' ? HINTS_RUNNING : HINTS_DONE), [phase.kind]);
  useViewHints(hints);

  return <ViewShell title={TITLE}>{renderBody(phase)}</ViewShell>;
}

function renderBody(phase: Phase): React.JSX.Element {
  switch (phase.kind) {
    case 'running':
      return <Spinner label={stepLabel(phase.step)} />;
    case 'no-tasks':
      return <ResultCard kind="info" title="No tasks in this sprint" />;
    case 'not-active':
      return (
        <ResultCard
          kind="warning"
          title="Status updates require an active sprint"
          lines={['Start the sprint from Home first.']}
        />
      );
    case 'error':
      return <ResultCard kind="error" title="Could not update status" lines={[phase.message]} />;
    case 'done':
      return (
        <ResultCard
          kind="success"
          title="Status updated"
          fields={[
            ['Task', phase.task.name],
            ['Status', phase.task.status],
          ]}
        />
      );
  }
}

function stepLabel(step: Extract<Phase, { kind: 'running' }>['step']): string {
  if (step === 'select-task') return 'Awaiting task selection…';
  if (step === 'select-status') return 'Awaiting status selection…';
  return 'Saving task…';
}
