/**
 * ProjectRemoveView — permanently remove a project.
 *
 * Lists projects, user selects one, confirms deletion, calls RemoveProjectUseCase.
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
import { runSelectConfirmRemove } from '../../components/run-select-confirm-remove.ts';
import { getSharedDeps, getPrompt } from '../../../bootstrap/get-shared-deps.ts';
import { RemoveProjectUseCase } from '../../../../business/usecases/project/remove-project.ts';
import { ListProjectsUseCase } from '../../../../business/usecases/project/list-projects.ts';
import { ProjectName } from '../../../../domain/values/project-name.ts';

const HINTS = [{ key: 'Enter', action: 'confirm (terminal state)' }] as const;

export function ProjectRemoveView(): React.JSX.Element {
  useViewHints(HINTS);
  const router = useRouter();
  const { phase, run } = useWorkflow<string>();

  useEffect(() => {
    run('Removing project…', async (setStep) => {
      const deps = await getSharedDeps();
      setStep('Loading projects…');
      const listUc = new ListProjectsUseCase(deps.projectRepo);
      const listed = await listUc.execute();
      if (!listed.ok) throw new Error(listed.error.message);
      if (listed.value.length === 0) throw new Error('No projects to remove.');

      const prompt = await getPrompt();
      setStep('Awaiting project selection…');
      const uc = new RemoveProjectUseCase(deps.projectRepo);
      const removed = await runSelectConfirmRemove({
        prompt,
        router,
        items: listed.value,
        selectMessage: 'Select project to remove',
        itemLabel: (p) => `${p.displayName} (${String(p.name)})`,
        itemId: (p) => String(p.name),
        confirmMessage: (p) => `Remove project "${p.displayName}"? This cannot be undone.`,
        remove: async (name) => {
          const nameResult = ProjectName.parse(name);
          if (!nameResult.ok) throw new Error(nameResult.error.message);
          setStep('Removing project…');
          const result = await uc.execute({ name: nameResult.value });
          if (!result.ok) throw new Error(result.error.message);
        },
      });

      return removed.displayName;
    });
  }, [run, router]);

  useInput((_input, key) => {
    if (phase.kind === 'done' && key.return) router.pop();
  });

  return (
    <ViewShell title="REMOVE PROJECT">
      {phase.kind === 'idle' || phase.kind === 'running' ? (
        <Spinner label={phase.kind === 'running' ? phase.label : 'Starting…'} />
      ) : phase.error !== null ? (
        <ResultCard
          kind="error"
          title="Failed to remove project"
          lines={[phase.error]}
          {...(phase.hint !== undefined ? { hint: phase.hint } : {})}
          nextSteps={[{ action: 'Press Enter to go back' }]}
        />
      ) : (
        <ResultCard
          kind="success"
          title="Project removed!"
          fields={[['Name', phase.value]]}
          nextSteps={[{ action: 'Press Enter to go back' }]}
        />
      )}
    </ViewShell>
  );
}
