/**
 * TaskReorderView — native Ink flow for `task reorder`.
 *
 * Pick a task → set its new order number. Relies on `reorderTask` which
 * shifts the rest of the list to make room.
 */

import React, { useMemo } from 'react';
import type { Task } from '@src/domain/models.ts';
import { getPrompt } from '@src/application/bootstrap.ts';
import { getCurrentSprintOrThrow } from '@src/integration/persistence/sprint.ts';
import { listTasks, reorderTask } from '@src/integration/persistence/task.ts';
import { ResultCard } from '@src/integration/ui/tui/components/result-card.tsx';
import { Spinner } from '@src/integration/ui/tui/components/spinner.tsx';
import { ViewShell } from '@src/integration/ui/tui/components/view-shell.tsx';
import { useViewHints } from '@src/integration/ui/tui/views/view-hints-context.tsx';
import { useWorkflow } from './use-workflow.ts';

const TITLE = 'Reorder Task' as const;

const HINTS_RUNNING = [{ key: 'Esc', action: 'cancel' }] as const;
const HINTS_DONE = [
  { key: 'Enter', action: 'home' },
  { key: 'Esc', action: 'back' },
] as const;

type Phase =
  | { kind: 'running'; step: 'select' | 'order' | 'saving' }
  | { kind: 'no-tasks' }
  | { kind: 'not-draft' }
  | { kind: 'done'; task: Task }
  | { kind: 'error'; message: string };

export function TaskReorderView(): React.JSX.Element {
  const { phase } = useWorkflow<Phase>({
    initial: { kind: 'running', step: 'select' },
    onError: (message) => ({ kind: 'error', message }),
    run: async ({ setPhase }) => {
      const prompt = getPrompt();

      const sprint = await getCurrentSprintOrThrow();
      if (sprint.status !== 'draft') {
        setPhase({ kind: 'not-draft' });
        return;
      }

      const tasks = await listTasks();
      if (tasks.length === 0) {
        setPhase({ kind: 'no-tasks' });
        return;
      }

      setPhase({ kind: 'running', step: 'select' });
      const taskId = await prompt.select<string>({
        message: 'Select task:',
        choices: tasks.map((t) => ({
          label: `${t.id} — ${t.name}`,
          value: t.id,
          description: `order ${String(t.order)}`,
        })),
      });

      setPhase({ kind: 'running', step: 'order' });
      const raw = await prompt.input({
        message: `New order (1–${String(tasks.length)}):`,
        validate: (v: string) => {
          const n = Number(v);
          if (!Number.isInteger(n) || n < 1 || n > tasks.length) return 'Enter a valid order number';
          return true;
        },
      });
      const newOrder = Number(raw);

      setPhase({ kind: 'running', step: 'saving' });
      const task = await reorderTask(taskId, newOrder);
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
    case 'not-draft':
      return <ResultCard kind="warning" title="Current sprint is not a draft" />;
    case 'error':
      return <ResultCard kind="error" title="Could not reorder" lines={[phase.message]} />;
    case 'done':
      return (
        <ResultCard
          kind="success"
          title="Task reordered"
          fields={[
            ['Name', phase.task.name],
            ['New order', String(phase.task.order)],
          ]}
        />
      );
  }
}

function stepLabel(step: 'select' | 'order' | 'saving'): string {
  if (step === 'select') return 'Awaiting task selection…';
  if (step === 'order') return 'Awaiting new order…';
  return 'Saving task…';
}
