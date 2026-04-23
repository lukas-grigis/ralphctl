/**
 * TaskRemoveView — native Ink flow for `task remove`.
 *
 * Validates draft-sprint state + picks a task; the shared
 * {@link RemovalWorkflow} owns the confirm + remove + done state machine.
 */

import React, { useEffect, useState } from 'react';
import { PromptCancelledError } from '@src/business/ports/prompt.ts';
import { getPrompt } from '@src/integration/bootstrap.ts';
import { getCurrentSprintOrThrow } from '@src/integration/persistence/sprint.ts';
import { listTasks, removeTask } from '@src/integration/persistence/task.ts';
import { RemovalWorkflow } from '@src/integration/ui/tui/components/removal-workflow.tsx';
import { ResultCard } from '@src/integration/ui/tui/components/result-card.tsx';
import { Spinner } from '@src/integration/ui/tui/components/spinner.tsx';
import { ViewShell } from '@src/integration/ui/tui/components/view-shell.tsx';
import { useRouter } from '@src/integration/ui/tui/views/router-context.ts';

const TITLE = 'Remove Task' as const;

type Phase =
  | { kind: 'loading' }
  | { kind: 'selecting' }
  | { kind: 'no-tasks' }
  | { kind: 'not-draft' }
  | { kind: 'ready'; taskId: string; taskName: string }
  | { kind: 'error'; message: string };

export function TaskRemoveView(): React.JSX.Element {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [started, setStarted] = useState(false);

  useEffect(() => {
    if (started) return;
    setStarted(true);
    void (async (): Promise<void> => {
      try {
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

        setPhase({ kind: 'selecting' });
        const taskId = await getPrompt().select<string>({
          message: 'Select task to remove:',
          choices: tasks.map((t) => ({ label: `${t.id} — ${t.name}`, value: t.id, description: t.status })),
        });
        const target = tasks.find((t) => t.id === taskId);
        if (!target) throw new Error(`Task ${taskId} disappeared`);

        setPhase({ kind: 'ready', taskId: target.id, taskName: target.name });
      } catch (err) {
        if (err instanceof PromptCancelledError) {
          router.pop();
          return;
        }
        setPhase({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
      }
    })();
  }, [started, router]);

  if (phase.kind === 'ready') {
    return (
      <RemovalWorkflow
        entityLabel={TITLE}
        confirmMessage={`Remove task "${phase.taskName}"? This cannot be undone.`}
        onConfirm={() => removeTask(phase.taskId)}
        successMessage={`Task "${phase.taskName}" removed`}
        onDone={() => {
          router.pop();
        }}
      />
    );
  }

  return <ViewShell title={TITLE}>{renderPre(phase)}</ViewShell>;
}

function renderPre(phase: Exclude<Phase, { kind: 'ready' }>): React.JSX.Element {
  switch (phase.kind) {
    case 'loading':
      return <Spinner label="Loading tasks…" />;
    case 'selecting':
      return <Spinner label="Awaiting task selection…" />;
    case 'no-tasks':
      return <ResultCard kind="info" title="No tasks to remove" />;
    case 'not-draft':
      return <ResultCard kind="warning" title="Current sprint is not a draft" />;
    case 'error':
      return <ResultCard kind="error" title="Could not remove task" lines={[phase.message]} />;
  }
}
