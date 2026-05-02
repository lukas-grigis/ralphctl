/**
 * TaskAddView — add a task directly to the current sprint.
 *
 * Prompts: name → project path (select from project repos) → description.
 * Calls AddTaskUseCase.
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
import { AddTaskUseCase } from '@src/business/usecases/task/add-task.ts';
import { ListProjectsUseCase } from '@src/business/usecases/project/list-projects.ts';
import { AbsolutePath } from '@src/domain/values/absolute-path.ts';
import { PromptCancelledError } from '@src/business/ports/prompt-port.ts';
import type { Task } from '@src/domain/entities/task.ts';

const HINTS = [{ key: 'Enter', action: 'confirm (terminal state)' }] as const;

export function TaskAddView(): React.JSX.Element {
  useViewHints(HINTS);
  const router = useRouter();
  const { phase, run } = useWorkflow<readonly Task[]>();

  useEffect(() => {
    run('Adding task…', async (setStep) => {
      const deps = await getSharedDeps();
      const idResult = await resolveCurrentSprintId(deps.configStore);
      if (!idResult.ok) throw new Error(idResult.error.message);

      setStep('Loading projects…');
      const projectsUc = new ListProjectsUseCase(deps.projectRepo);
      const projectsResult = await projectsUc.execute();
      if (!projectsResult.ok) throw new Error(projectsResult.error.message);

      const prompt = await getPrompt();
      let taskName: string | undefined;
      let nameError: string | null = null;
      while (taskName === undefined) {
        setStep(nameError !== null ? `${nameError} — try again…` : 'Awaiting task name…');
        const rawName = (await promptOrPop(router, () => prompt.input({ message: 'Task name', default: '' }))).trim();
        if (rawName === '') {
          nameError = 'Task name cannot be empty';
        } else {
          taskName = rawName;
        }
      }
      const name: string = taskName;

      setStep('Awaiting project path…');
      const repoPaths = projectsResult.value.flatMap((p) =>
        p.repositories.map((r) => ({ label: `${p.displayName} — ${r.name} (${r.path})`, value: r.path }))
      );

      const projectPath: string =
        repoPaths.length === 0
          ? await promptOrPop(router, () => prompt.input({ message: 'Project path (absolute)', default: '' }))
          : await promptOrPop(router, () =>
              prompt.select<string>({ message: 'Project repository', choices: repoPaths })
            );

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
  }, [run, router]);

  useViewInput((_input, key) => {
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
          {...(phase.hint !== undefined ? { hint: phase.hint } : {})}
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
