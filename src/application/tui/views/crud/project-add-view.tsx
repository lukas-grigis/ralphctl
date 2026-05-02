/**
 * ProjectAddView — register a new project with one initial repository.
 *
 * Prompts:
 *   1. Slug / name (input, retries inline on invalid slug)
 *   2. Display name (input)
 *   3. Repository path (fileBrowser or input)
 *   4. Check script (optional input)
 *   5. Description (optional input)
 *
 * Calls CreateProjectUseCase. Shows ResultCard on terminal state.
 *
 * Keyboard: Enter on terminal state → pop view.
 */

import React, { useEffect } from 'react';
import { useViewInput } from '@src/application/tui/views/use-view-input.ts';
import { ViewShell } from '@src/application/tui/components/view-shell.tsx';
import { Spinner } from '@src/application/tui/components/spinner.tsx';
import { ResultCard } from '@src/application/tui/components/result-card.tsx';
import { FirstLaunchIntroCard } from '@src/application/tui/components/first-launch-intro-card.tsx';
import { useViewHints } from '@src/application/tui/views/view-hints-context.tsx';
import { useRouter } from '@src/application/tui/views/router-context.ts';
import { useWorkflow } from '@src/application/tui/components/use-workflow.ts';
import { promptOrPop } from '@src/application/tui/components/prompt-or-pop.ts';
import { getSharedDeps, getPrompt } from '@src/application/bootstrap/get-shared-deps.ts';
import { CreateProjectUseCase } from '@src/business/usecases/project/create-project.ts';
import { Repository } from '@src/domain/entities/repository.ts';
import { AbsolutePath } from '@src/domain/values/absolute-path.ts';
import { ProjectName } from '@src/domain/values/project-name.ts';
import { PromptCancelledError } from '@src/business/ports/prompt-port.ts';
import type { Project } from '@src/domain/entities/project.ts';

const HINTS = [{ key: 'Enter', action: 'confirm (terminal state)' }] as const;

export interface ProjectAddViewProps {
  /**
   * Render the first-launch intro card above the form. Set when the boot
   * path routed the user here because they have no projects yet — see
   * `isFirstLaunch` in `runtime/first-launch.ts`.
   */
  readonly firstLaunch?: boolean;
}

export function ProjectAddView({ firstLaunch = false }: ProjectAddViewProps = {}): React.JSX.Element {
  useViewHints(HINTS);
  const router = useRouter();
  const { phase, run } = useWorkflow<Project>();

  useEffect(() => {
    run('Adding project…', async (setStep) => {
      const prompt = await getPrompt();

      let projectName: ProjectName | null = null;
      let nameError: string | null = null;
      let nameStr = ''; // Preserved for the display name default.
      while (projectName === null) {
        setStep(nameError !== null ? `${nameError} — try again…` : 'Awaiting project name…');
        const rawName = await promptOrPop(router, () =>
          prompt.input({ message: 'Project slug (lowercase alnum + hyphens)', default: '' })
        );
        const nameResult = ProjectName.parse(rawName.trim());
        if (!nameResult.ok) {
          nameError = nameResult.error.message;
        } else {
          nameStr = rawName;
          projectName = nameResult.value;
        }
      }

      setStep('Awaiting display name…');
      const displayName = await promptOrPop(router, () => prompt.input({ message: 'Display name', default: nameStr }));

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

      setStep('Awaiting description…');
      let description: string | undefined;
      try {
        const raw = await prompt.input({ message: 'Description (optional)', default: '' });
        description = raw.trim() !== '' ? raw.trim() : undefined;
      } catch (err) {
        if (err instanceof PromptCancelledError) description = undefined;
        else throw err;
      }

      const repoResult = Repository.create({
        path: pathResult.value,
        ...(checkScript !== undefined ? { checkScript } : {}),
      });
      if (!repoResult.ok) throw new Error(repoResult.error.message);

      setStep('Saving project…');
      const deps = await getSharedDeps();
      const uc = new CreateProjectUseCase(deps.projectRepo);
      const result = await uc.execute({
        name: projectName,
        displayName: displayName.trim(),
        ...(description !== undefined ? { description } : {}),
        repositories: [repoResult.value],
      });
      if (!result.ok) throw new Error(result.error.message);

      return result.value;
    });
  }, [run, router]);

  useViewInput((_input, key) => {
    if (phase.kind === 'done' && key.return) router.pop();
  });

  return (
    <ViewShell title="ADD PROJECT">
      {firstLaunch ? <FirstLaunchIntroCard /> : null}
      {phase.kind === 'idle' || phase.kind === 'running' ? (
        <Spinner label={phase.kind === 'running' ? phase.label : 'Starting…'} />
      ) : phase.error !== null ? (
        <ResultCard
          kind="error"
          title="Failed to add project"
          lines={[phase.error]}
          {...(phase.hint !== undefined ? { hint: phase.hint } : {})}
          nextSteps={[{ action: 'Press Enter to go back' }]}
        />
      ) : (
        <ResultCard
          kind="success"
          title="Project created!"
          fields={[
            ['Name', String(phase.value.name)],
            ['Display', phase.value.displayName],
            ['Repos', String(phase.value.repositories.length)],
          ]}
          nextSteps={[{ action: 'Press Enter to go back' }]}
        />
      )}
    </ViewShell>
  );
}
