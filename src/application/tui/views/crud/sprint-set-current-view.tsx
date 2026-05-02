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
import { useViewInput } from '@src/application/tui/views/use-view-input.ts';
import { ViewShell } from '@src/application/tui/components/view-shell.tsx';
import { Spinner } from '@src/application/tui/components/spinner.tsx';
import { ResultCard } from '@src/application/tui/components/result-card.tsx';
import { useViewHints } from '@src/application/tui/views/view-hints-context.tsx';
import { useRouter } from '@src/application/tui/views/router-context.ts';
import { useWorkflow } from '@src/application/tui/components/use-workflow.ts';
import { promptOrPop } from '@src/application/tui/components/prompt-or-pop.ts';
import { getSharedDeps, getPrompt } from '@src/application/bootstrap/get-shared-deps.ts';
import { ListSprintsUseCase } from '@src/business/usecases/sprint/list-sprints.ts';
import { SetCurrentSprintUseCase } from '@src/application/config/set-current-sprint.ts';
import { SprintId } from '@src/domain/values/sprint-id.ts';

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
      const picked = await promptOrPop(router, () =>
        prompt.select<string>({
          message: 'Set current sprint',
          choices: [
            { label: '(none — clear)', value: NONE_SENTINEL },
            ...list.value.map((s) => ({ label: `${s.name} [${s.status}]`, value: String(s.id) })),
          ],
        })
      );

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
  }, [run, router]);

  useViewInput((_input, key) => {
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
