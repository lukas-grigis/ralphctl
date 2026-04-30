/**
 * SprintEditView — edit a sprint's name and/or branch.
 *
 * If `sprintId` is supplied via router props, edits that sprint directly;
 * otherwise prompts the user to pick from the sprint list. Empty branch
 * input clears the sprint branch (delegates to {@link Sprint.clearBranch}).
 *
 * Calls `EditSprintUseCase` which validates via the entity and persists
 * via `SprintRepository.save()`.
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
import { EditSprintUseCase } from '../../../../business/usecases/sprint/edit-sprint.ts';
import { ListSprintsUseCase } from '../../../../business/usecases/sprint/list-sprints.ts';
import { ShowSprintUseCase } from '../../../../business/usecases/sprint/show-sprint.ts';
import { SprintId } from '../../../../domain/values/sprint-id.ts';
import type { Sprint } from '../../../../domain/entities/sprint.ts';

const HINTS = [{ key: 'Enter', action: 'confirm (terminal state)' }] as const;

interface Props {
  readonly sprintId?: string;
}

export function SprintEditView({ sprintId }: Props = {}): React.JSX.Element {
  useViewHints(HINTS);
  const router = useRouter();
  const { phase, run } = useWorkflow<Sprint>();

  useEffect(() => {
    run('Editing sprint…', async (setStep) => {
      const deps = await getSharedDeps();
      const prompt = await getPrompt();

      let target: Sprint;
      if (sprintId !== undefined) {
        const parsed = SprintId.parse(sprintId);
        if (!parsed.ok) throw new Error(parsed.error.message);
        const showUc = new ShowSprintUseCase(deps.sprintRepo);
        const r = await showUc.execute({ id: parsed.value });
        if (!r.ok) throw new Error(r.error.message);
        target = r.value;
      } else {
        setStep('Loading sprints…');
        const listUc = new ListSprintsUseCase(deps.sprintRepo);
        const list = await listUc.execute();
        if (!list.ok) throw new Error(list.error.message);
        const editable = list.value.filter((s) => s.status !== 'closed');
        if (editable.length === 0) throw new Error('No editable sprints (all are closed or empty).');

        setStep('Awaiting sprint selection…');
        const pickedId = await promptOrPop(router, () =>
          prompt.select<string>({
            message: 'Select sprint to edit',
            choices: editable.map((s) => ({
              label: `${s.name} [${s.status}]`,
              value: String(s.id),
            })),
          })
        );
        const parsed = SprintId.parse(pickedId);
        if (!parsed.ok) throw new Error(parsed.error.message);
        const found = editable.find((s) => String(s.id) === pickedId);
        if (!found) throw new Error('Sprint not found.');
        target = found;
      }

      let newName: string | undefined;
      let nameError: string | null = null;
      while (newName === undefined) {
        setStep(nameError !== null ? `${nameError} — try again…` : 'Awaiting new name…');
        const raw = (
          await promptOrPop(router, () => prompt.input({ message: 'Sprint name', default: target.name }))
        ).trim();
        if (raw === '') {
          nameError = 'Sprint name cannot be empty';
        } else {
          newName = raw;
        }
      }

      // Branch prompt. Empty string => clear (null). Default = current branch.
      setStep('Awaiting branch…');
      const rawBranch = await promptOrPop(router, () =>
        prompt.input({
          message: 'Branch (empty to clear)',
          default: target.branch ?? '',
        })
      );
      const trimmedBranch = rawBranch.trim();
      const branchInput: string | null | undefined =
        trimmedBranch === '' ? (target.branch !== null ? null : undefined) : trimmedBranch;

      setStep('Saving sprint…');
      const uc = new EditSprintUseCase(deps.sprintRepo);
      const result = await uc.execute({
        id: target.id,
        name: newName !== target.name ? newName : undefined,
        ...(branchInput !== undefined ? { branch: branchInput } : {}),
      });
      if (!result.ok) throw new Error(result.error.message);
      return result.value;
    });
  }, [run, router, sprintId]);

  useInput((_input, key) => {
    if (phase.kind === 'done' && key.return) router.pop();
  });

  return (
    <ViewShell title="EDIT SPRINT">
      {phase.kind === 'idle' || phase.kind === 'running' ? (
        <Spinner label={phase.kind === 'running' ? phase.label : 'Starting…'} />
      ) : phase.error !== null ? (
        <ResultCard
          kind="error"
          title="Failed to edit sprint"
          lines={[phase.error]}
          {...(phase.hint !== undefined ? { hint: phase.hint } : {})}
          nextSteps={[{ action: 'Press Enter to go back' }]}
        />
      ) : (
        <ResultCard
          kind="success"
          title="Sprint updated!"
          fields={[
            ['Name', phase.value.name],
            ['Branch', phase.value.branch ?? '—'],
          ]}
          nextSteps={[{ action: 'Press Enter to go back' }]}
        />
      )}
    </ViewShell>
  );
}
