/**
 * SprintActivateView — explicit "activate this draft sprint" surface.
 *
 * `sprint start` auto-activates draft sprints, so this view is for users
 * who want to activate without immediately starting execution. Loads the
 * target sprint (by `sprintId` prop or current sprint), confirms via a
 * yes/no prompt, then calls `ActivateSprintUseCase`.
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
import { ActivateSprintUseCase } from '../../../../business/usecases/sprint/activate-sprint.ts';
import { ShowSprintUseCase } from '../../../../business/usecases/sprint/show-sprint.ts';
import { IsoTimestamp } from '../../../../domain/values/iso-timestamp.ts';
import { SprintId } from '../../../../domain/values/sprint-id.ts';
import { PromptCancelledError } from '../../../ui/prompt-cancelled-error.ts';
import type { Sprint } from '../../../../domain/entities/sprint.ts';

const HINTS = [{ key: 'Enter', action: 'confirm (terminal state)' }] as const;

interface Props {
  readonly sprintId?: string;
}

export function SprintActivateView({ sprintId }: Props = {}): React.JSX.Element {
  useViewHints(HINTS);
  const router = useRouter();
  const { phase, run } = useWorkflow<Sprint>();

  useEffect(() => {
    run('Activating sprint…', async (setStep) => {
      const deps = await getSharedDeps();

      let idStr: string;
      if (sprintId !== undefined) {
        idStr = sprintId;
      } else {
        const config = await deps.configStore.load();
        if (!config.ok) throw new Error(config.error.message);
        if (!config.value.currentSprint) {
          throw new Error('No sprint selected. Open this from the sprint list, or set a current sprint.');
        }
        idStr = config.value.currentSprint;
      }
      const parsed = SprintId.parse(idStr);
      if (!parsed.ok) throw new Error(parsed.error.message);

      setStep('Loading sprint…');
      const showUc = new ShowSprintUseCase(deps.sprintRepo);
      const found = await showUc.execute({ id: parsed.value });
      if (!found.ok) throw new Error(found.error.message);
      const sprint = found.value;

      if (sprint.status !== 'draft') {
        throw new Error(`Cannot activate a ${sprint.status} sprint. Only draft sprints can be activated.`);
      }

      const prompt = await getPrompt();
      setStep('Awaiting confirmation…');
      let confirmed: boolean;
      try {
        confirmed = await prompt.confirm({
          message: `Activate sprint "${sprint.name}"?`,
          default: true,
        });
      } catch (err) {
        if (err instanceof PromptCancelledError) {
          router.pop();
          throw err;
        }
        throw err;
      }
      if (!confirmed) {
        throw new Error('Cancelled.');
      }

      setStep('Activating…');
      const uc = new ActivateSprintUseCase(deps.sprintRepo);
      const result = await uc.execute({ id: parsed.value, now: IsoTimestamp.now() });
      if (!result.ok) throw new Error(result.error.message);
      return result.value;
    });
  }, [run, router, sprintId]);

  useInput((_input, key) => {
    if (phase.kind === 'done' && key.return) router.pop();
  });

  return (
    <ViewShell title="ACTIVATE SPRINT">
      {phase.kind === 'idle' || phase.kind === 'running' ? (
        <Spinner label={phase.kind === 'running' ? phase.label : 'Starting…'} />
      ) : phase.error !== null ? (
        <ResultCard
          kind="error"
          title="Failed to activate sprint"
          lines={[phase.error]}
          {...(phase.hint !== undefined ? { hint: phase.hint } : {})}
          nextSteps={[{ action: 'Press Enter to go back' }]}
        />
      ) : (
        <ResultCard
          kind="success"
          title="Sprint activated!"
          fields={[
            ['Name', phase.value.name],
            ['Status', phase.value.status.toUpperCase()],
          ]}
          nextSteps={[{ action: 'Press Enter to go back' }]}
        />
      )}
    </ViewShell>
  );
}
