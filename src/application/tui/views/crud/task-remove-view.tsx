/**
 * TaskRemoveView — remove a task from the current sprint.
 *
 * Prompts: select task → confirm.
 * Calls RemoveTaskUseCase.
 *
 * Keyboard: Enter on terminal state → pop view.
 */

import React, { useEffect } from 'react';
import { useViewInput } from '@src/application/tui/views/use-view-input.ts';
import { ViewShell } from '@src/application/tui/components/view-shell.tsx';
import { Spinner } from '@src/application/tui/components/spinner.tsx';
import { ResultCard } from '@src/application/tui/components/result-card.tsx';
import { useViewHints } from '@src/application/tui/views/view-hints-context.tsx';
import { useRouter } from '@src/application/tui/views/router-context.ts';
import { useWorkflow } from '@src/application/tui/components/use-workflow.ts';
import { runSelectConfirmRemove } from '@src/application/tui/components/run-select-confirm-remove.ts';
import { resolveCurrentSprintId } from '@src/application/tui/components/resolve-current-sprint.ts';
import { getSharedDeps, getPrompt } from '@src/application/bootstrap/get-shared-deps.ts';
import { RemoveTaskUseCase } from '@src/business/usecases/task/remove-task.ts';
import { ListTasksUseCase } from '@src/business/usecases/task/list-tasks.ts';
import { TaskId } from '@src/domain/values/task-id.ts';

const HINTS = [{ key: 'Enter', action: 'confirm (terminal state)' }] as const;

export function TaskRemoveView(): React.JSX.Element {
  useViewHints(HINTS);
  const router = useRouter();
  const { phase, run } = useWorkflow<string>();

  useEffect(() => {
    run('Removing task…', async (setStep) => {
      const deps = await getSharedDeps();
      const idResult = await resolveCurrentSprintId(deps.configStore);
      if (!idResult.ok) throw new Error(idResult.error.message);

      setStep('Loading tasks…');
      const listUc = new ListTasksUseCase(deps.taskRepo);
      const tasksResult = await listUc.execute({ sprintId: idResult.value });
      if (!tasksResult.ok) throw new Error(tasksResult.error.message);
      if (tasksResult.value.length === 0) throw new Error('No tasks in current sprint.');

      const prompt = await getPrompt();
      setStep('Awaiting task selection…');
      const uc = new RemoveTaskUseCase(deps.taskRepo);
      const removed = await runSelectConfirmRemove({
        prompt,
        router,
        items: tasksResult.value,
        selectMessage: 'Select task to remove',
        itemLabel: (t) => `#${String(t.order)} [${t.status.toUpperCase()}] ${t.name}`,
        itemId: (t) => String(t.id),
        confirmMessage: (t) => `Remove task "${t.name}"?`,
        remove: async (id) => {
          const taskIdResult = TaskId.parse(id);
          if (!taskIdResult.ok) throw new Error(taskIdResult.error.message);
          setStep('Removing task…');
          const result = await uc.execute({ sprintId: idResult.value, taskId: taskIdResult.value });
          if (!result.ok) throw new Error(result.error.message);
        },
      });

      return removed.name;
    });
  }, [run, router]);

  useViewInput((_input, key) => {
    if (phase.kind === 'done' && key.return) router.pop();
  });

  return (
    <ViewShell title="REMOVE TASK">
      {phase.kind === 'idle' || phase.kind === 'running' ? (
        <Spinner label={phase.kind === 'running' ? phase.label : 'Starting…'} />
      ) : phase.error !== null ? (
        <ResultCard
          kind="error"
          title="Failed to remove task"
          lines={[phase.error]}
          {...(phase.hint !== undefined ? { hint: phase.hint } : {})}
          nextSteps={[{ action: 'Press Enter to go back' }]}
        />
      ) : (
        <ResultCard
          kind="success"
          title="Task removed!"
          fields={[['Name', phase.value]]}
          nextSteps={[{ action: 'Press Enter to go back' }]}
        />
      )}
    </ViewShell>
  );
}
