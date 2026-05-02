/**
 * SprintRemoveView — select and delete a sprint.
 *
 * Prompts user to select from available sprints (or uses currentSprint),
 * confirms deletion, then calls RemoveSprintUseCase.
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
import { runSelectConfirmRemove } from '@src/application/tui/components/run-select-confirm-remove.ts';
import { getSharedDeps, getPrompt } from '@src/application/bootstrap/get-shared-deps.ts';
import { RemoveSprintUseCase } from '@src/business/usecases/sprint/remove-sprint.ts';
import { ListSprintsUseCase } from '@src/business/usecases/sprint/list-sprints.ts';
import { SprintId } from '@src/domain/values/sprint-id.ts';

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
      const uc = new RemoveSprintUseCase(deps.sprintRepo);
      const removed = await runSelectConfirmRemove({
        prompt,
        router,
        items: listed.value,
        selectMessage: 'Select sprint to remove',
        itemLabel: (s) => `[${s.status.toUpperCase()}] ${s.name} (${String(s.id)})`,
        itemId: (s) => String(s.id),
        confirmMessage: (s) => `Permanently remove sprint "${s.name}"?`,
        remove: async (id) => {
          const idResult = SprintId.parse(id);
          if (!idResult.ok) throw new Error(idResult.error.message);
          setStep('Removing sprint…');
          const result = await uc.execute({ id: idResult.value });
          if (!result.ok) throw new Error(result.error.message);
        },
      });

      return removed.name;
    });
  }, [run, router]);

  useViewInput((_input, key) => {
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
