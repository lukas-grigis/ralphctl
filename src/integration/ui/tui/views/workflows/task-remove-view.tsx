/**
 * TaskRemoveView — native Ink flow for `task remove`.
 */

import React, { useMemo } from 'react';
import { getPrompt } from '@src/integration/bootstrap.ts';
import { getCurrentSprintOrThrow } from '@src/integration/persistence/sprint.ts';
import { listTasks, removeTask } from '@src/integration/persistence/task.ts';
import { ResultCard } from '@src/integration/ui/tui/components/result-card.tsx';
import { Spinner } from '@src/integration/ui/tui/components/spinner.tsx';
import { ViewShell } from '@src/integration/ui/tui/components/view-shell.tsx';
import { useViewHints } from '@src/integration/ui/tui/views/view-hints-context.tsx';
import { useWorkflow } from './use-workflow.ts';

const TITLE = 'Remove Task' as const;

const HINTS_RUNNING = [{ key: 'Esc', action: 'cancel' }] as const;
const HINTS_DONE = [
  { key: 'Enter', action: 'home' },
  { key: 'Esc', action: 'back' },
] as const;

type Phase =
  | { kind: 'running'; step: 'select' | 'confirm' | 'removing' }
  | { kind: 'no-tasks' }
  | { kind: 'not-draft' }
  | { kind: 'cancelled' }
  | { kind: 'done'; id: string; name: string }
  | { kind: 'error'; message: string };

export function TaskRemoveView(): React.JSX.Element {
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
        message: 'Select task to remove:',
        choices: tasks.map((t) => ({ label: `${t.id} — ${t.name}`, value: t.id, description: t.status })),
      });
      const target = tasks.find((t) => t.id === taskId);
      if (!target) throw new Error(`Task ${taskId} disappeared`);

      setPhase({ kind: 'running', step: 'confirm' });
      const ok = await prompt.confirm({
        message: `Remove task "${target.name}"?`,
        default: false,
      });
      if (!ok) {
        setPhase({ kind: 'cancelled' });
        return;
      }

      setPhase({ kind: 'running', step: 'removing' });
      await removeTask(taskId);
      setPhase({ kind: 'done', id: target.id, name: target.name });
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
      return <ResultCard kind="info" title="No tasks to remove" />;
    case 'not-draft':
      return <ResultCard kind="warning" title="Current sprint is not a draft" />;
    case 'cancelled':
      return <ResultCard kind="info" title="Removal cancelled" />;
    case 'error':
      return <ResultCard kind="error" title="Could not remove task" lines={[phase.message]} />;
    case 'done':
      return (
        <ResultCard
          kind="success"
          title="Task removed"
          fields={[
            ['ID', phase.id],
            ['Name', phase.name],
          ]}
        />
      );
  }
}

function stepLabel(step: 'select' | 'confirm' | 'removing'): string {
  if (step === 'select') return 'Awaiting task selection…';
  if (step === 'confirm') return 'Awaiting confirmation…';
  return 'Removing task…';
}
