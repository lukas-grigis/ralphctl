/**
 * SprintRemoveView — select and delete a sprint.
 *
 * Prompts user to select from available sprints (or uses currentSprint),
 * confirms deletion, then calls RemoveSprintUseCase.
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
import { RemoveSprintUseCase } from '../../../../business/usecases/sprint/remove-sprint.ts';
import { ListSprintsUseCase } from '../../../../business/usecases/sprint/list-sprints.ts';
import { SprintId } from '../../../../domain/values/sprint-id.ts';
import { PromptCancelledError } from '../../../ui/prompt-cancelled-error.ts';

const HINTS = [{ key: 'Enter', action: 'confirm (terminal state)' }] as const;

export function SprintRemoveView(): React.JSX.Element {
  useViewHints(HINTS);
  const router = useRouter();
  const { phase, run } = useWorkflow<string>();

  useEffect(() => {
    run('Removing sprint…', async (setStep) => {
      const deps = await getSharedDeps();
      setStep('Loading sprints…');
      const listUc = new ListSprintsUseCase(deps.sprintRepo);
      const listed = await listUc.execute();
      if (!listed.ok) throw new Error(listed.error.message);
      if (listed.value.length === 0) throw new Error('No sprints to remove.');

      setStep('Awaiting sprint selection…');
      const prompt = await getPrompt();
      let selectedId: string;
      try {
        selectedId = await prompt.select<string>({
          message: 'Select sprint to remove',
          choices: listed.value.map((s) => ({
            label: `[${s.status.toUpperCase()}] ${s.name} (${String(s.id)})`,
            value: String(s.id),
          })),
        });
      } catch (err) {
        if (err instanceof PromptCancelledError) {
          router.pop();
          throw err;
        }
        throw err;
      }

      const sprint = listed.value.find((s) => String(s.id) === selectedId);
      const sprintName = sprint?.name ?? selectedId;

      setStep('Awaiting confirmation…');
      let confirmed: boolean;
      try {
        confirmed = await prompt.confirm({
          message: `Permanently remove sprint "${sprintName}"?`,
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

      const idResult = SprintId.parse(selectedId);
      if (!idResult.ok) throw new Error(idResult.error.message);

      setStep('Removing sprint…');
      const uc = new RemoveSprintUseCase(deps.sprintRepo);
      const result = await uc.execute({ id: idResult.value });
      if (!result.ok) throw new Error(result.error.message);

      return sprintName;
    });
  }, [run, router]);

  useInput((_input, key) => {
    if (phase.kind === 'done' && key.return) router.pop();
  });

  return (
    <ViewShell title="REMOVE SPRINT">
      {phase.kind === 'idle' || phase.kind === 'running' ? (
        <Spinner label={phase.kind === 'running' ? phase.label : 'Starting…'} />
      ) : phase.error !== null ? (
        <ResultCard
          kind="error"
          title="Failed to remove sprint"
          lines={[phase.error]}
          {...(phase.hint !== undefined ? { hint: phase.hint } : {})}
          nextSteps={[{ action: 'Press Enter to go back' }]}
        />
      ) : (
        <ResultCard
          kind="success"
          title="Sprint removed!"
          fields={[['Name', phase.value]]}
          nextSteps={[{ action: 'Press Enter to go back' }]}
        />
      )}
    </ViewShell>
  );
}
