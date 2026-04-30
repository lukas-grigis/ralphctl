/**
 * TaskRemoveView — remove a task from the current sprint.
 *
 * Prompts: select task → confirm.
 * Calls RemoveTaskUseCase.
 *
 * Keyboard: Enter on terminal state → pop view.
 */

import React, { useEffect } from 'react';
import { useInput } from 'ink';
import { ViewShell } from '../../components/view-shell.tsx';
import { Spinner } from '../../components/spinner.tsx';
import { ResultCard } from '../../components/result-card.tsx';
import { useViewHints } from '../view-hints-context.tsx';
import { useRouter } from '../router-context.ts';
import { useWorkflow } from '../../components/use-workflow.ts';
import { getSharedDeps, getPrompt } from '../../../bootstrap/get-shared-deps.ts';
import { RemoveTaskUseCase } from '../../../../business/usecases/task/remove-task.ts';
import { ListTasksUseCase } from '../../../../business/usecases/task/list-tasks.ts';
import { SprintId } from '../../../../domain/values/sprint-id.ts';
import { TaskId } from '../../../../domain/values/task-id.ts';
import { PromptCancelledError } from '../../../ui/prompt-cancelled-error.ts';

const HINTS = [{ key: 'Enter', action: 'confirm (terminal state)' }] as const;

export function TaskRemoveView(): React.JSX.Element {
  useViewHints(HINTS);
  const router = useRouter();
  const { phase, run } = useWorkflow<string>();

  useEffect(() => {
    run('Removing task…', async (setStep) => {
      const deps = await getSharedDeps();
      const config = await deps.configStore.load();
      if (!config.ok) throw new Error(config.error.message);
      const sprintIdStr = config.value.currentSprint;
      if (!sprintIdStr) throw new Error('No current sprint. Set one via Settings.');
      const idResult = SprintId.parse(sprintIdStr);
      if (!idResult.ok) throw new Error(idResult.error.message);

      setStep('Loading tasks…');
      const listUc = new ListTasksUseCase(deps.taskRepo);
      const tasksResult = await listUc.execute({ sprintId: idResult.value });
      if (!tasksResult.ok) throw new Error(tasksResult.error.message);
      if (tasksResult.value.length === 0) throw new Error('No tasks in current sprint.');

      const prompt = await getPrompt();
      setStep('Awaiting task selection…');
      let taskIdStr: string;
      try {
        taskIdStr = await prompt.select<string>({
          message: 'Select task to remove',
          choices: tasksResult.value.map((t) => ({
            label: `#${String(t.order)} [${t.status.toUpperCase()}] ${t.name}`,
            value: String(t.id),
          })),
        });
      } catch (err) {
        if (err instanceof PromptCancelledError) {
          router.pop();
          throw err;
        }
        throw err;
      }

      const task = tasksResult.value.find((t) => String(t.id) === taskIdStr);
      const taskName = task?.name ?? taskIdStr;

      setStep('Awaiting confirmation…');
      let confirmed: boolean;
      try {
        confirmed = await prompt.confirm({
          message: `Remove task "${taskName}"?`,
          default: false,
        });
      } catch (err) {
        if (err instanceof PromptCancelledError) {
          router.pop();
          throw err;
        }
        throw err;
      }
      if (!confirmed) {
        router.pop();
        throw new Error('Cancelled.');
      }

      const taskIdResult = TaskId.parse(taskIdStr);
      if (!taskIdResult.ok) throw new Error(taskIdResult.error.message);

      setStep('Removing task…');
      const uc = new RemoveTaskUseCase(deps.taskRepo);
      const result = await uc.execute({ sprintId: idResult.value, taskId: taskIdResult.value });
      if (!result.ok) throw new Error(result.error.message);

      return taskName;
    });
  }, [run, router]);

  useInput((_input, key) => {
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
