/**
 * TaskEditStatusView — update status of a task in the current sprint.
 *
 * Prompts: select task → select action (mark-in-progress | mark-done).
 * Calls EditTaskStatusUseCase.
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
import { promptOrPop } from '@src/application/tui/components/prompt-or-pop.ts';
import { resolveCurrentSprintId } from '@src/application/tui/components/resolve-current-sprint.ts';
import { getSharedDeps, getPrompt } from '@src/application/bootstrap/get-shared-deps.ts';
import {
  EditTaskStatusUseCase,
  type EditTaskStatusAction,
  type EditTaskStatusActionKind,
} from '@src/business/usecases/task/edit-task-status.ts';
import { ListTasksUseCase } from '@src/business/usecases/task/list-tasks.ts';
import { TaskId } from '@src/domain/values/task-id.ts';
import type { Task } from '@src/domain/entities/task.ts';

const HINTS = [{ key: 'Enter', action: 'confirm (terminal state)' }] as const;

export function TaskEditStatusView(): React.JSX.Element {
  useViewHints(HINTS);
  const router = useRouter();
  const { phase, run } = useWorkflow<Task>();

  useEffect(() => {
    run('Updating task status…', async (setStep) => {
      const deps = await getSharedDeps();
      const idResult = await resolveCurrentSprintId(deps.configStore);
      if (!idResult.ok) throw new Error(idResult.error.message);

      setStep('Loading tasks…');
      const listUc = new ListTasksUseCase(deps.taskRepo);
      const tasksResult = await listUc.execute({ sprintId: idResult.value });
      if (!tasksResult.ok) throw new Error(tasksResult.error.message);

      const activeTasks = tasksResult.value.filter((t) => t.status !== 'done');
      if (activeTasks.length === 0) throw new Error('No tasks to update (all are done or sprint is empty).');

      const prompt = await getPrompt();
      setStep('Awaiting task selection…');
      const taskIdStr = await promptOrPop(router, () =>
        prompt.select<string>({
          message: 'Select task',
          choices: activeTasks.map((t) => ({
            label: `[${t.status.replace('_', ' ').toUpperCase()}] #${String(t.order)} ${t.name}`,
            value: String(t.id),
          })),
        })
      );

      const task = activeTasks.find((t) => String(t.id) === taskIdStr);
      if (!task) throw new Error('Task not found.');

      const availableActions: { label: string; value: EditTaskStatusActionKind }[] = [];
      if (task.status === 'todo') {
        availableActions.push({ label: 'Mark in progress', value: 'mark-in-progress' });
        availableActions.push({ label: 'Mark blocked', value: 'mark-blocked' });
      }
      if (task.status === 'in_progress') {
        availableActions.push({ label: 'Mark done', value: 'mark-done' });
        availableActions.push({ label: 'Mark blocked', value: 'mark-blocked' });
      }
      if (task.status === 'blocked') {
        availableActions.push({ label: 'Unblock', value: 'unblock' });
      }
      if (availableActions.length === 0) throw new Error('No valid transitions for this task.');

      setStep('Awaiting action selection…');
      const actionKind = await promptOrPop(router, () =>
        prompt.select<EditTaskStatusActionKind>({
          message: 'Action',
          choices: availableActions,
        })
      );

      let action: EditTaskStatusAction;
      if (actionKind === 'mark-blocked') {
        setStep('Awaiting block reason…');
        const reason = await promptOrPop(router, () =>
          prompt.input({
            message: 'Reason for blocking',
          })
        );
        if (reason.trim().length === 0) throw new Error('Reason is required when blocking a task.');
        action = { kind: 'mark-blocked', reason };
      } else {
        action = { kind: actionKind };
      }

      const taskIdResult = TaskId.parse(taskIdStr);
      if (!taskIdResult.ok) throw new Error(taskIdResult.error.message);

      setStep('Updating task…');
      const uc = new EditTaskStatusUseCase(deps.taskRepo);
      const result = await uc.execute({
        sprintId: idResult.value,
        taskId: taskIdResult.value,
        action,
      });
      if (!result.ok) throw new Error(result.error.message);
      return result.value;
    });
  }, [run, router]);

  useViewInput((_input, key) => {
    if (phase.kind === 'done' && key.return) router.pop();
  });

  return (
    <ViewShell title="UPDATE TASK STATUS">
      {phase.kind === 'idle' || phase.kind === 'running' ? (
        <Spinner label={phase.kind === 'running' ? phase.label : 'Starting…'} />
      ) : phase.error !== null ? (
        <ResultCard
          kind="error"
          title="Failed to update task"
          lines={[phase.error]}
          {...(phase.hint !== undefined ? { hint: phase.hint } : {})}
          nextSteps={[{ action: 'Press Enter to go back' }]}
        />
      ) : (
        <ResultCard
          kind="success"
          title="Task updated!"
          fields={[
            ['Name', phase.value.name],
            ['Status', phase.value.status.replace('_', ' ').toUpperCase()],
          ]}
          nextSteps={[{ action: 'Press Enter to go back' }]}
        />
      )}
    </ViewShell>
  );
}
