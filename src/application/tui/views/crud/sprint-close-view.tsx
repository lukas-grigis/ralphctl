/**
 * SprintCloseView — confirm and close the current active sprint.
 *
 * Prompts for confirmation, then calls CloseSprintUseCase.
 * Shows ResultCard on terminal state.
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
import { CloseSprintUseCase } from '../../../../business/usecases/sprint/close-sprint.ts';
import { SprintId } from '../../../../domain/values/sprint-id.ts';
import { IsoTimestamp } from '../../../../domain/values/iso-timestamp.ts';
import { PromptCancelledError } from '../../../ui/prompt-cancelled-error.ts';
import type { Sprint } from '../../../../domain/entities/sprint.ts';

const HINTS = [{ key: 'Enter', action: 'confirm (terminal state)' }] as const;

export function SprintCloseView(): React.JSX.Element {
  useViewHints(HINTS);
  const router = useRouter();
  const { phase, run } = useWorkflow<Sprint>();

  useEffect(() => {
    run('Closing sprint…', async (setStep) => {
      const deps = await getSharedDeps();
      const config = await deps.configStore.load();
      if (!config.ok) throw new Error(config.error.message);
      const sprintIdStr = config.value.currentSprint;
      if (!sprintIdStr) throw new Error('No current sprint configured.');
      const idResult = SprintId.parse(sprintIdStr);
      if (!idResult.ok) throw new Error(idResult.error.message);

      // Load sprint so we can show its name in the confirmation
      setStep('Loading sprint…');
      const sprintResult = await deps.sprintRepo.findById(idResult.value);
      if (!sprintResult.ok) throw new Error(sprintResult.error.message);
      const sprint = sprintResult.value;

      setStep('Awaiting confirmation…');
      const prompt = await getPrompt();
      let confirmed: boolean;
      try {
        confirmed = await prompt.confirm({
          message: `Close sprint "${sprint.name}"? This cannot be undone.`,
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

      setStep('Closing sprint…');
      const uc = new CloseSprintUseCase(deps.sprintRepo);
      const result = await uc.execute({ id: idResult.value, now: IsoTimestamp.now() });
      if (!result.ok) throw new Error(result.error.message);

      return result.value;
    });
  }, []);

  useInput((_input, key) => {
    if (phase.kind === 'done' && key.return) router.pop();
  });

  return (
    <ViewShell title="CLOSE SPRINT">
      {phase.kind === 'idle' || phase.kind === 'running' ? (
        <Spinner label={phase.kind === 'running' ? phase.label : 'Starting…'} />
      ) : phase.error !== null ? (
        <ResultCard
          kind="error"
          title="Failed to close sprint"
          lines={[phase.error]}
          nextSteps={[{ action: 'Press Enter to go back' }]}
        />
      ) : (
        <ResultCard
          kind="success"
          title="Sprint closed!"
          fields={[
            ['ID', String(phase.value.id)],
            ['Name', phase.value.name],
          ]}
          nextSteps={[{ action: 'Press Enter to go back' }]}
        />
      )}
    </ViewShell>
  );
}
