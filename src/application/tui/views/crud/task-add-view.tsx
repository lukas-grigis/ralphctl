/**
 * TaskAddView — add a task directly to the current sprint.
 *
 * Prompts: name → project path (select from project repos) → description.
 * Calls AddTaskUseCase.
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
import { AddTaskUseCase } from '../../../../business/usecases/task/add-task.ts';
import { ListProjectsUseCase } from '../../../../business/usecases/project/list-projects.ts';
import { AbsolutePath } from '../../../../domain/values/absolute-path.ts';
import { SprintId } from '../../../../domain/values/sprint-id.ts';
import { PromptCancelledError } from '../../../ui/prompt-cancelled-error.ts';
import type { Task } from '../../../../domain/entities/task.ts';

const HINTS = [{ key: 'Enter', action: 'confirm (terminal state)' }] as const;

export function TaskAddView(): React.JSX.Element {
  useViewHints(HINTS);
  const router = useRouter();
  const { phase, run } = useWorkflow<readonly Task[]>();

  useEffect(() => {
    run('Adding task…', async (setStep) => {
      const deps = await getSharedDeps();
      const config = await deps.configStore.load();
      if (!config.ok) throw new Error(config.error.message);
      const sprintIdStr = config.value.currentSprint;
      if (!sprintIdStr) throw new Error('No current sprint. Set one via Settings.');
      const idResult = SprintId.parse(sprintIdStr);
      if (!idResult.ok) throw new Error(idResult.error.message);

      // Collect available repo paths from all projects
      setStep('Loading projects…');
      const projectsUc = new ListProjectsUseCase(deps.projectRepo);
      const projectsResult = await projectsUc.execute();
      if (!projectsResult.ok) throw new Error(projectsResult.error.message);

      const prompt = await getPrompt();
      // Task name — retry loop on empty input.
      let taskName: string | undefined;
      let nameError: string | null = null;
      while (taskName === undefined) {
        setStep(nameError !== null ? `${nameError} — try again…` : 'Awaiting task name…');
        let rawName: string;
        try {
          rawName = (await prompt.input({ message: 'Task name', default: '' })).trim();
        } catch (err) {
          if (err instanceof PromptCancelledError) {
            router.pop();
            throw err;
          }
          throw err;
        }
        if (rawName === '') {
          nameError = 'Task name cannot be empty';
        } else {
          taskName = rawName;
        }
      }
      const name: string = taskName;

      setStep('Awaiting project path…');
      let projectPath: string;
      const repoPaths = projectsResult.value.flatMap((p) =>
        p.repositories.map((r) => ({ label: `${p.displayName} — ${r.name} (${r.path})`, value: r.path }))
      );

      if (repoPaths.length === 0) {
        // Fall back to manual entry
        try {
          projectPath = await prompt.input({ message: 'Project path (absolute)', default: '' });
        } catch (err) {
          if (err instanceof PromptCancelledError) {
            router.pop();
            throw err;
          }
          throw err;
        }
      } else {
        try {
          projectPath = await prompt.select<string>({
            message: 'Project repository',
            choices: repoPaths,
          });
        } catch (err) {
          if (err instanceof PromptCancelledError) {
            router.pop();
            throw err;
          }
          throw err;
        }
      }

      const pathResult = AbsolutePath.parse(projectPath);
      if (!pathResult.ok) throw new Error(pathResult.error.message);

      setStep('Awaiting description…');
      let description: string | undefined;
      try {
        const raw = await prompt.editor({ message: 'Description (optional — Ctrl+D to skip)' });
        description = raw?.trim() ?? undefined;
      } catch (err) {
        if (err instanceof PromptCancelledError) description = undefined;
        else throw err;
      }

      setStep('Saving task…');
      const uc = new AddTaskUseCase(deps.taskRepo);
      const result = await uc.execute({
        sprintId: idResult.value,
        taskInput: {
          name,
          projectPath: pathResult.value,
          steps: [],
          verificationCriteria: [],
          ...(description !== undefined ? { description } : {}),
        },
      });
      if (!result.ok) throw new Error(result.error.message);
      return result.value;
    });
  }, []);

  useInput((_input, key) => {
    if (phase.kind === 'done' && key.return) router.pop();
  });

  return (
    <ViewShell title="ADD TASK">
      {phase.kind === 'idle' || phase.kind === 'running' ? (
        <Spinner label={phase.kind === 'running' ? phase.label : 'Starting…'} />
      ) : phase.error !== null ? (
        <ResultCard
          kind="error"
          title="Failed to add task"
          lines={[phase.error]}
          nextSteps={[{ action: 'Press Enter to go back' }]}
        />
      ) : (
        <ResultCard
          kind="success"
          title="Task added!"
          fields={[
            ['Tasks', String(phase.value.length)],
            ['Last', phase.value[phase.value.length - 1]?.name ?? '—'],
          ]}
          nextSteps={[{ action: 'Press Enter to go back' }]}
        />
      )}
    </ViewShell>
  );
}
