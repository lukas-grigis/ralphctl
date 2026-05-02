/**
 * ProjectEditView — edit repository config on an existing project.
 *
 * Prompts:
 *   1. Select project
 *   2. Select repository
 *   3. Edit check script
 *
 * Calls UpdateRepositoryConfigUseCase.
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
import { getSharedDeps, getPrompt } from '@src/application/bootstrap/get-shared-deps.ts';
import { UpdateRepositoryConfigUseCase } from '@src/business/usecases/project/update-repository-config.ts';
import { ListProjectsUseCase } from '@src/business/usecases/project/list-projects.ts';
import { ProjectName } from '@src/domain/values/project-name.ts';
import { AbsolutePath } from '@src/domain/values/absolute-path.ts';
import type { Project } from '@src/domain/entities/project.ts';

const HINTS = [{ key: 'Enter', action: 'confirm (terminal state)' }] as const;

export function ProjectEditView(): React.JSX.Element {
  useViewHints(HINTS);
  const router = useRouter();
  const { phase, run } = useWorkflow<Project>();

  useEffect(() => {
    run('Editing project…', async (setStep) => {
      const deps = await getSharedDeps();
      setStep('Loading projects…');
      const listUc = new ListProjectsUseCase(deps.projectRepo);
      const listed = await listUc.execute();
      if (!listed.ok) throw new Error(listed.error.message);
      if (listed.value.length === 0) throw new Error('No projects to edit.');

      const prompt = await getPrompt();
      setStep('Awaiting project selection…');
      const projectNameStr = await promptOrPop(router, () =>
        prompt.select<string>({
          message: 'Select project',
          choices: listed.value.map((p) => ({
            label: p.displayName,
            value: String(p.name),
          })),
        })
      );

      const project = listed.value.find((p) => String(p.name) === projectNameStr);
      if (!project) throw new Error('Project not found.');
      if (project.repositories.length === 0) throw new Error('Project has no repositories.');

      setStep('Awaiting repository selection…');
      const repoPath = await promptOrPop(router, () =>
        prompt.select<string>({
          message: 'Select repository',
          choices: project.repositories.map((r) => ({
            label: `${r.name} (${r.path})`,
            value: r.path,
          })),
        })
      );

      const existingRepo = project.repositories.find((r) => r.path === repoPath);
      setStep('Awaiting check script…');
      const checkScriptRaw = await promptOrPop(router, () =>
        prompt.input({
          message: 'Check script (leave blank to clear)',
          default: existingRepo?.checkScript ?? '',
        })
      );
      const checkScript: string | undefined = checkScriptRaw.trim() !== '' ? checkScriptRaw.trim() : undefined;

      const nameResult = ProjectName.parse(projectNameStr);
      if (!nameResult.ok) throw new Error(nameResult.error.message);
      const pathResult = AbsolutePath.parse(repoPath);
      if (!pathResult.ok) throw new Error(pathResult.error.message);

      setStep('Saving changes…');
      const uc = new UpdateRepositoryConfigUseCase(deps.projectRepo);
      const result = await uc.execute({
        projectName: nameResult.value,
        path: pathResult.value,
        partial: { checkScript },
      });
      if (!result.ok) throw new Error(result.error.message);
      return result.value;
    });
  }, [run, router]);

  useViewInput((_input, key) => {
    if (phase.kind === 'done' && key.return) router.pop();
  });

  return (
    <ViewShell title="EDIT PROJECT">
      {phase.kind === 'idle' || phase.kind === 'running' ? (
        <Spinner label={phase.kind === 'running' ? phase.label : 'Starting…'} />
      ) : phase.error !== null ? (
        <ResultCard
          kind="error"
          title="Failed to edit project"
          lines={[phase.error]}
          {...(phase.hint !== undefined ? { hint: phase.hint } : {})}
          nextSteps={[{ action: 'Press Enter to go back' }]}
        />
      ) : (
        <ResultCard
          kind="success"
          title="Project updated!"
          fields={[
            ['Name', String(phase.value.name)],
            ['Repos', String(phase.value.repositories.length)],
          ]}
          nextSteps={[{ action: 'Press Enter to go back' }]}
        />
      )}
    </ViewShell>
  );
}
