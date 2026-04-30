/**
 * TaskEditStatusView — update status of a task in the current sprint.
 *
 * Prompts: select task → select action (mark-in-progress | mark-done).
 * Calls EditTaskStatusUseCase.
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
import {
  EditTaskStatusUseCase,
  type EditTaskStatusAction,
  type EditTaskStatusActionKind,
} from '../../../../business/usecases/task/edit-task-status.ts';
import { ListTasksUseCase } from '../../../../business/usecases/task/list-tasks.ts';
import { SprintId } from '../../../../domain/values/sprint-id.ts';
import { TaskId } from '../../../../domain/values/task-id.ts';
import { PromptCancelledError } from '../../../ui/prompt-cancelled-error.ts';
import type { Task } from '../../../../domain/entities/task.ts';

const HINTS = [{ key: 'Enter', action: 'confirm (terminal state)' }] as const;

export function TaskEditStatusView(): React.JSX.Element {
  useViewHints(HINTS);
  const router = useRouter();
  const { phase, run } = useWorkflow<Task>();

  useEffect(() => {
    run('Updating task status…', async (setStep) => {
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

      const activeTasks = tasksResult.value.filter((t) => t.status !== 'done');
      if (activeTasks.length === 0) throw new Error('No tasks to update (all are done or sprint is empty).');

      const prompt = await getPrompt();
      setStep('Awaiting task selection…');
      let taskIdStr: string;
      try {
        taskIdStr = await prompt.select<string>({
          message: 'Select task',
          choices: activeTasks.map((t) => ({
            label: `[${t.status.replace('_', ' ').toUpperCase()}] #${String(t.order)} ${t.name}`,
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
      let actionKind: EditTaskStatusActionKind;
      try {
        actionKind = await prompt.select<EditTaskStatusActionKind>({
          message: 'Action',
          choices: availableActions,
        });
      } catch (err) {
        if (err instanceof PromptCancelledError) {
          router.pop();
          throw err;
        }
        throw err;
      }

      let action: EditTaskStatusAction;
      if (actionKind === 'mark-blocked') {
        setStep('Awaiting block reason…');
        let reason: string;
        try {
          reason = await prompt.input({
            message: 'Reason for blocking',
          });
        } catch (err) {
          if (err instanceof PromptCancelledError) {
            router.pop();
            throw err;
          }
          throw err;
        }
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
  }, []);

  useInput((_input, key) => {
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
