/**
 * TaskNextView — native read-only view for `task next`.
 *
 * Shows the next available (unblocked, todo) task so the user can see what
 * the executor would pick up.
 */

import React, { useMemo } from 'react';
import type { Task } from '@src/domain/models.ts';
import { getNextTask } from '@src/integration/persistence/task.ts';
import { ResultCard } from '@src/integration/ui/tui/components/result-card.tsx';
import { Spinner } from '@src/integration/ui/tui/components/spinner.tsx';
import { ViewShell } from '@src/integration/ui/tui/components/view-shell.tsx';
import { useViewHints } from '@src/integration/ui/tui/views/view-hints-context.tsx';
import { useWorkflow } from './use-workflow.ts';

const TITLE = 'Next Task' as const;

const HINTS_RUNNING = [{ key: 'Esc', action: 'cancel' }] as const;
const HINTS_DONE = [
  { key: 'Enter', action: 'home' },
  { key: 'Esc', action: 'back' },
] as const;

type Phase =
  | { kind: 'running' }
  | { kind: 'none' }
  | { kind: 'ready'; task: Task }
  | { kind: 'error'; message: string };

export function TaskNextView(): React.JSX.Element {
  const { phase } = useWorkflow<Phase>({
    initial: { kind: 'running' },
    onError: (message) => ({ kind: 'error', message }),
    run: async ({ setPhase }) => {
      const task = await getNextTask();
      if (!task) {
        setPhase({ kind: 'none' });
        return;
      }
      setPhase({ kind: 'ready', task });
    },
  });

  const hints = useMemo(() => (phase.kind === 'running' ? HINTS_RUNNING : HINTS_DONE), [phase.kind]);
  useViewHints(hints);

  return <ViewShell title={TITLE}>{renderBody(phase)}</ViewShell>;
}

function renderBody(phase: Phase): React.JSX.Element {
  switch (phase.kind) {
    case 'running':
      return <Spinner label="Resolving next task…" />;
    case 'none':
      return <ResultCard kind="info" title="No task available" lines={['All tasks are done or blocked.']} />;
    case 'error':
      return <ResultCard kind="error" title="Could not resolve next task" lines={[phase.message]} />;
    case 'ready':
      return (
        <ResultCard
          kind="info"
          title="Next up"
          fields={[
            ['ID', phase.task.id],
            ['Name', phase.task.name],
            ['Order', String(phase.task.order)],
            ['Status', phase.task.status],
            ['Project Path', phase.task.projectPath],
          ]}
        />
      );
  }
}
