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
import { ActivateSprintUseCase } from '@src/business/usecases/sprint/activate-sprint.ts';
import { ShowSprintUseCase } from '@src/business/usecases/sprint/show-sprint.ts';
import { IsoTimestamp } from '@src/domain/values/iso-timestamp.ts';
import { SprintId } from '@src/domain/values/sprint-id.ts';
import type { Sprint } from '@src/domain/entities/sprint.ts';

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

      let resolvedId;
      if (sprintId !== undefined) {
        const parsed = SprintId.parse(sprintId);
        if (!parsed.ok) throw new Error(parsed.error.message);
        resolvedId = parsed.value;
      } else {
        const resolved = await resolveCurrentSprintId(deps.configStore);
        if (!resolved.ok) throw new Error(resolved.error.message);
        resolvedId = resolved.value;
      }

      setStep('Loading sprint…');
      const showUc = new ShowSprintUseCase(deps.sprintRepo);
      const found = await showUc.execute({ id: resolvedId });
      if (!found.ok) throw new Error(found.error.message);
      const sprint = found.value;

      if (sprint.status !== 'draft') {
        throw new Error(`Cannot activate a ${sprint.status} sprint. Only draft sprints can be activated.`);
      }

      const prompt = await getPrompt();
      setStep('Awaiting confirmation…');
      const confirmed = await promptOrPop(router, () =>
        prompt.confirm({
          message: `Activate sprint "${sprint.name}"?`,
          default: true,
        })
      );
      if (!confirmed) {
        throw new Error('Cancelled.');
      }

      setStep('Activating…');
      const uc = new ActivateSprintUseCase(deps.sprintRepo);
      const result = await uc.execute({ id: resolvedId, now: IsoTimestamp.now() });
      if (!result.ok) throw new Error(result.error.message);
      return result.value;
    });
  }, [run, router, sprintId]);

  useViewInput((_input, key) => {
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
