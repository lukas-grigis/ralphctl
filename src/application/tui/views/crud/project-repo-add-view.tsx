/**
 * ProjectRepoAddView — add a repository to an existing project.
 *
 * Prompts: select project → repo path → check script (optional).
 * Calls AddRepositoryToProjectUseCase.
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
import { getSharedDeps, getPrompt } from '../../../bootstrap/get-shared-deps.ts';
import { AddRepositoryToProjectUseCase } from '../../../../business/usecases/project/add-repository-to-project.ts';
import { ListProjectsUseCase } from '../../../../business/usecases/project/list-projects.ts';
import { AbsolutePath } from '../../../../domain/values/absolute-path.ts';
import { ProjectName } from '../../../../domain/values/project-name.ts';
import { PromptCancelledError } from '../../../ui/prompt-cancelled-error.ts';
import type { Project } from '../../../../domain/entities/project.ts';

const HINTS = [{ key: 'Enter', action: 'confirm (terminal state)' }] as const;

export function ProjectRepoAddView(): React.JSX.Element {
  useViewHints(HINTS);
  const router = useRouter();
  const { phase, run } = useWorkflow<Project>();

  useEffect(() => {
    run('Adding repository…', async (setStep) => {
      const deps = await getSharedDeps();
      setStep('Loading projects…');
      const listUc = new ListProjectsUseCase(deps.projectRepo);
      const listed = await listUc.execute();
      if (!listed.ok) throw new Error(listed.error.message);
      if (listed.value.length === 0) throw new Error('No projects found. Add a project first.');

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

      setStep('Awaiting repository path…');
      const repoPath = await promptOrPop(router, () =>
        prompt.fileBrowser({ startPath: process.cwd(), message: 'Repository path (directory)' })
      );
      if (repoPath === null || repoPath.trim() === '') throw new Error('Repository path is required.');

      const pathResult = AbsolutePath.parse(repoPath.trim());
      if (!pathResult.ok) throw new Error(pathResult.error.message);

      setStep('Awaiting check script…');
      let checkScript: string | undefined;
      try {
        const raw = await prompt.input({ message: 'Check script (optional, leave blank to skip)', default: '' });
        checkScript = raw.trim() !== '' ? raw.trim() : undefined;
      } catch (err) {
        if (err instanceof PromptCancelledError) checkScript = undefined;
        else throw err;
      }

      const nameResult = ProjectName.parse(projectNameStr);
      if (!nameResult.ok) throw new Error(nameResult.error.message);

      setStep('Saving repository…');
      const uc = new AddRepositoryToProjectUseCase(deps.projectRepo);
      const result = await uc.execute({
        projectName: nameResult.value,
        repository: {
          path: pathResult.value,
          ...(checkScript !== undefined ? { checkScript } : {}),
        },
      });
      if (!result.ok) throw new Error(result.error.message);
      return result.value;
    });
  }, [run, router]);

  useInput((_input, key) => {
    if (phase.kind === 'done' && key.return) router.pop();
  });

  return (
    <ViewShell title="ADD REPO">
      {phase.kind === 'idle' || phase.kind === 'running' ? (
        <Spinner label={phase.kind === 'running' ? phase.label : 'Starting…'} />
      ) : phase.error !== null ? (
        <ResultCard
          kind="error"
          title="Failed to add repository"
          lines={[phase.error]}
          {...(phase.hint !== undefined ? { hint: phase.hint } : {})}
          nextSteps={[{ action: 'Press Enter to go back' }]}
        />
      ) : (
        <ResultCard
          kind="success"
          title="Repository added!"
          fields={[
            ['Project', String(phase.value.name)],
            ['Repos', String(phase.value.repositories.length)],
          ]}
          nextSteps={[{ action: 'Press Enter to go back' }]}
        />
      )}
    </ViewShell>
  );
}
