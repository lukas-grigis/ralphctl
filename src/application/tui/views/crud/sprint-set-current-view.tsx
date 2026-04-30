/**
 * SprintSetCurrentView — pick which sprint the CLI commands target by
 * default by setting the `currentSprint` config pointer.
 *
 * Picker shows every persisted sprint plus a "(none)" option that clears
 * the pointer. Calls `SetCurrentSprintUseCase` which verifies the sprint
 * exists before writing config.
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
import { ListSprintsUseCase } from '../../../../business/usecases/sprint/list-sprints.ts';
import { SetCurrentSprintUseCase } from '../../../config/set-current-sprint.ts';
import { SprintId } from '../../../../domain/values/sprint-id.ts';
import { PromptCancelledError } from '../../../ui/prompt-cancelled-error.ts';

const NONE_SENTINEL = '__NONE__';

const HINTS = [{ key: 'Enter', action: 'confirm (terminal state)' }] as const;

interface Result {
  readonly cleared: boolean;
  readonly sprintName: string | null;
}

export function SprintSetCurrentView(): React.JSX.Element {
  useViewHints(HINTS);
  const router = useRouter();
  const { phase, run } = useWorkflow<Result>();

  useEffect(() => {
    run('Setting current sprint…', async (setStep) => {
      const deps = await getSharedDeps();

      setStep('Loading sprints…');
      const listUc = new ListSprintsUseCase(deps.sprintRepo);
      const list = await listUc.execute();
      if (!list.ok) throw new Error(list.error.message);

      const prompt = await getPrompt();
      setStep('Awaiting sprint selection…');
      let picked: string;
      try {
        picked = await prompt.select<string>({
          message: 'Set current sprint',
          choices: [
            { label: '(none — clear)', value: NONE_SENTINEL },
            ...list.value.map((s) => ({ label: `${s.name} [${s.status}]`, value: String(s.id) })),
          ],
        });
      } catch (err) {
        if (err instanceof PromptCancelledError) {
          router.pop();
          throw err;
        }
        throw err;
      }

      setStep('Saving config…');
      const uc = new SetCurrentSprintUseCase(deps.sprintRepo, deps.configStore);

      if (picked === NONE_SENTINEL) {
        const r = await uc.execute({ id: null });
        if (!r.ok) throw new Error(r.error.message);
        return { cleared: true, sprintName: null };
      }

      const parsed = SprintId.parse(picked);
      if (!parsed.ok) throw new Error(parsed.error.message);
      const r = await uc.execute({ id: parsed.value });
      if (!r.ok) throw new Error(r.error.message);
      const found = list.value.find((s) => String(s.id) === picked);
      return { cleared: false, sprintName: found?.name ?? picked };
    });
  }, []);

  useInput((_input, key) => {
    if (phase.kind === 'done' && key.return) router.pop();
  });

  return (
    <ViewShell title="SET CURRENT SPRINT">
      {phase.kind === 'idle' || phase.kind === 'running' ? (
        <Spinner label={phase.kind === 'running' ? phase.label : 'Starting…'} />
      ) : phase.error !== null ? (
        <ResultCard
          kind="error"
          title="Failed to set current sprint"
          lines={[phase.error]}
          {...(phase.hint !== undefined ? { hint: phase.hint } : {})}
          nextSteps={[{ action: 'Press Enter to go back' }]}
        />
      ) : phase.value.cleared ? (
        <ResultCard kind="success" title="Current sprint cleared." nextSteps={[{ action: 'Press Enter to go back' }]} />
      ) : (
        <ResultCard
          kind="success"
          title="Current sprint set!"
          fields={[['Sprint', phase.value.sprintName ?? '—']]}
          nextSteps={[{ action: 'Press Enter to go back' }]}
        />
      )}
    </ViewShell>
  );
}
