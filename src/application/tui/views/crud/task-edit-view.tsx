/**
 * TaskEditView — full-field edit for a task in the current sprint.
 *
 * Prompts: select task (if not provided via `taskId` prop) → name →
 * description (multi-line editor) → steps (one per line) → verification
 * criteria (one per line) → extraDimensions (comma-separated) →
 * projectPath (select from project repos or keep current).
 *
 * Calls `EditTaskUseCase`. Only `todo` tasks are editable — the entity
 * enforces this; the picker filters them out client-side too.
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
import { promptOrPop } from '../../components/prompt-or-pop.ts';
import { resolveCurrentSprintId } from '../../components/resolve-current-sprint.ts';
import { getSharedDeps, getPrompt } from '../../../bootstrap/get-shared-deps.ts';
import { EditTaskUseCase } from '../../../../business/usecases/task/edit-task.ts';
import { ListTasksUseCase } from '../../../../business/usecases/task/list-tasks.ts';
import { ListProjectsUseCase } from '../../../../business/usecases/project/list-projects.ts';
import { AbsolutePath } from '../../../../domain/values/absolute-path.ts';
import { TaskId } from '../../../../domain/values/task-id.ts';
import { PromptCancelledError } from '../../../ui/prompt-cancelled-error.ts';
import type { Task } from '../../../../domain/entities/task.ts';

const HINTS = [{ key: 'Enter', action: 'confirm (terminal state)' }] as const;

const KEEP_CURRENT_PATH = '__KEEP__';

interface Props {
  readonly taskId?: string;
}

function linesFromInput(raw: string): string[] {
  return raw
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function csvFromInput(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function TaskEditView({ taskId }: Props = {}): React.JSX.Element {
  useViewHints(HINTS);
  const router = useRouter();
  const { phase, run } = useWorkflow<Task>();

  useEffect(() => {
    run('Editing task…', async (setStep) => {
      const deps = await getSharedDeps();
      const idResult = await resolveCurrentSprintId(deps.configStore);
      if (!idResult.ok) throw new Error(idResult.error.message);

      setStep('Loading tasks…');
      const listUc = new ListTasksUseCase(deps.taskRepo);
      const tasksResult = await listUc.execute({ sprintId: idResult.value });
      if (!tasksResult.ok) throw new Error(tasksResult.error.message);

      // Only `todo` tasks are editable.
      const editable = tasksResult.value.filter((t) => t.status === 'todo');
      if (editable.length === 0) throw new Error('No editable tasks (only todo tasks can be edited).');

      const prompt = await getPrompt();

      let target: Task;
      if (taskId !== undefined) {
        const found = editable.find((t) => String(t.id) === taskId);
        if (!found) throw new Error('Task not found, or it is no longer in todo status.');
        target = found;
      } else {
        setStep('Awaiting task selection…');
        const pickedId = await promptOrPop(router, () =>
          prompt.select<string>({
            message: 'Select task to edit',
            choices: editable.map((t) => ({
              label: `#${String(t.order)} ${t.name}`,
              value: String(t.id),
            })),
          })
        );
        const found = editable.find((t) => String(t.id) === pickedId);
        if (!found) throw new Error('Task not found.');
        target = found;
      }

      let newName: string | undefined;
      let nameError: string | null = null;
      while (newName === undefined) {
        setStep(nameError !== null ? `${nameError} — try again…` : 'Awaiting task name…');
        const raw = (
          await promptOrPop(router, () => prompt.input({ message: 'Task name', default: target.name }))
        ).trim();
        if (raw === '') {
          nameError = 'Task name cannot be empty';
        } else {
          newName = raw;
        }
      }

      // Empty editor result clears the description (null sentinel).
      setStep('Awaiting description…');
      let descriptionInput: string | null | undefined;
      try {
        const raw = await prompt.editor({ message: 'Description (Ctrl+D to keep current)' });
        if (raw === null) {
          descriptionInput = undefined; // cancelled — leave unchanged
        } else {
          const trimmed = raw.trim();
          descriptionInput = trimmed.length === 0 ? null : trimmed;
        }
      } catch (err) {
        if (err instanceof PromptCancelledError) {
          descriptionInput = undefined;
        } else throw err;
      }

      setStep('Awaiting steps…');
      let stepsInput: readonly string[] | undefined;
      try {
        const raw = await prompt.editor({
          message: 'Steps (one per line, Ctrl+D to keep current)',
        });
        stepsInput = raw === null ? undefined : linesFromInput(raw);
      } catch (err) {
        if (err instanceof PromptCancelledError) {
          stepsInput = undefined;
        } else throw err;
      }

      setStep('Awaiting verification criteria…');
      let criteriaInput: readonly string[] | undefined;
      try {
        const raw = await prompt.editor({
          message: 'Verification criteria (one per line, Ctrl+D to keep current)',
        });
        criteriaInput = raw === null ? undefined : linesFromInput(raw);
      } catch (err) {
        if (err instanceof PromptCancelledError) {
          criteriaInput = undefined;
        } else throw err;
      }

      setStep('Awaiting extra dimensions…');
      let extraInput: readonly string[] | null | undefined;
      try {
        const raw = await prompt.input({
          message: 'Extra evaluator dimensions (comma-separated, empty to clear)',
          default: target.extraDimensions ? target.extraDimensions.join(', ') : '',
        });
        const trimmed = raw.trim();
        if (trimmed.length === 0) {
          extraInput = target.extraDimensions !== undefined ? null : undefined;
        } else {
          extraInput = csvFromInput(trimmed);
        }
      } catch (err) {
        if (err instanceof PromptCancelledError) {
          extraInput = undefined;
        } else throw err;
      }

      setStep('Loading projects…');
      const projectsUc = new ListProjectsUseCase(deps.projectRepo);
      const projectsResult = await projectsUc.execute();
      if (!projectsResult.ok) throw new Error(projectsResult.error.message);
      const repoChoices = projectsResult.value.flatMap((p) =>
        p.repositories.map((r) => ({ label: `${p.displayName} — ${r.name} (${r.path})`, value: r.path }))
      );

      let projectPath: AbsolutePath | undefined;
      setStep('Awaiting project path…');
      try {
        const picked = await prompt.select<string>({
          message: 'Project path',
          choices: [{ label: `(keep current — ${target.projectPath})`, value: KEEP_CURRENT_PATH }, ...repoChoices],
        });
        if (picked !== KEEP_CURRENT_PATH) {
          const parsed = AbsolutePath.parse(picked);
          if (!parsed.ok) throw new Error(parsed.error.message);
          projectPath = parsed.value;
        }
      } catch (err) {
        if (err instanceof PromptCancelledError) {
          // keep current
          projectPath = undefined;
        } else throw err;
      }

      const tidResult = TaskId.parse(String(target.id));
      if (!tidResult.ok) throw new Error(tidResult.error.message);

      setStep('Saving task…');
      const uc = new EditTaskUseCase(deps.taskRepo);
      const result = await uc.execute({
        sprintId: idResult.value,
        taskId: tidResult.value,
        ...(newName !== target.name ? { name: newName } : {}),
        ...(descriptionInput !== undefined ? { description: descriptionInput } : {}),
        ...(stepsInput !== undefined ? { steps: stepsInput } : {}),
        ...(criteriaInput !== undefined ? { verificationCriteria: criteriaInput } : {}),
        ...(extraInput !== undefined ? { extraDimensions: extraInput } : {}),
        ...(projectPath !== undefined ? { projectPath } : {}),
      });
      if (!result.ok) throw new Error(result.error.message);
      return result.value;
    });
  }, [run, router, taskId]);

  useInput((_input, key) => {
    if (phase.kind === 'done' && key.return) router.pop();
  });

  return (
    <ViewShell title="EDIT TASK">
      {phase.kind === 'idle' || phase.kind === 'running' ? (
        <Spinner label={phase.kind === 'running' ? phase.label : 'Starting…'} />
      ) : phase.error !== null ? (
        <ResultCard
          kind="error"
          title="Failed to edit task"
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
            ['Steps', String(phase.value.steps.length)],
            ['Criteria', String(phase.value.verificationCriteria.length)],
            ['Project', String(phase.value.projectPath)],
          ]}
          nextSteps={[{ action: 'Press Enter to go back' }]}
        />
      )}
    </ViewShell>
  );
}
