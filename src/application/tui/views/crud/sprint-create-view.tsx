/**
 * SprintCreateView — interactive sprint creation form.
 *
 * Pre-flight: if no projects exist, shows a warning card instead of entering
 * the form — a sprint without projects is a dead-end.
 *
 * Prompts:
 *   1. Sprint name (input, retries inline on empty)
 *   2. Slug (input, retries inline on invalid slug)
 *
 * On submit, calls CreateSprintUseCase then sets currentSprint in config.
 * Shows ResultCard on success / error.
 *
 * Keyboard:
 *   Enter on success / generic error → pop view.
 *   a on no-projects warning → navigate to project-add.
 *   Esc / Enter on no-projects warning → go back.
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
import { CreateSprintUseCase } from '../../../../business/usecases/sprint/create-sprint.ts';
import { ListProjectsUseCase } from '../../../../business/usecases/project/list-projects.ts';
import { Slug } from '../../../../domain/values/slug.ts';
import { IsoTimestamp } from '../../../../domain/values/iso-timestamp.ts';
import { PromptCancelledError } from '../../../ui/prompt-cancelled-error.ts';
import type { Sprint } from '../../../../domain/entities/sprint.ts';

/**
 * Sentinel string used as phase.error when no projects exist.
 * Keeps the no-projects UI path separate from generic errors.
 */
const NO_PROJECTS_ERROR = 'NO_PROJECTS';

const HINTS = [{ key: 'Enter', action: 'confirm (terminal state)' }] as const;

function toSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export function SprintCreateView(): React.JSX.Element {
  useViewHints(HINTS);
  const router = useRouter();
  const { phase, run } = useWorkflow<Sprint>();

  useEffect(() => {
    run('Creating sprint…', async (setStep) => {
      const deps = await getSharedDeps();

      // Pre-flight: require at least one project.
      setStep('Checking projects…');
      const listUc = new ListProjectsUseCase(deps.projectRepo);
      const projectsResult = await listUc.execute();
      if (!projectsResult.ok) throw new Error(projectsResult.error.message);
      if (projectsResult.value.length === 0) {
        throw new Error(NO_PROJECTS_ERROR);
      }

      const prompt = await getPrompt();

      let name: string | undefined;
      let nameError: string | null = null;
      while (name === undefined) {
        setStep(nameError !== null ? `${nameError} — try again…` : 'Awaiting sprint name…');
        let raw: string;
        try {
          raw = (await prompt.input({ message: 'Sprint name', default: '' })).trim();
        } catch (err) {
          if (err instanceof PromptCancelledError) {
            router.pop();
            throw err;
          }
          throw err;
        }
        if (raw === '') {
          nameError = 'Sprint name cannot be empty';
        } else {
          name = raw;
        }
      }
      const sprintName: string = name;

      let slug: Slug | null = null;
      let slugError: string | null = null;
      while (slug === null) {
        const suggested = toSlug(sprintName);
        setStep(slugError !== null ? `${slugError} — try again…` : 'Awaiting slug…');
        let slugStr: string;
        try {
          slugStr = await prompt.input({ message: 'Slug (lowercase alnum + hyphens)', default: suggested });
        } catch (err) {
          if (err instanceof PromptCancelledError) {
            router.pop();
            throw err;
          }
          throw err;
        }
        const slugResult = Slug.parse(slugStr);
        if (!slugResult.ok) {
          slugError = slugResult.error.message;
          continue;
        }
        slug = slugResult.value;
      }

      setStep('Saving sprint…');
      const uc = new CreateSprintUseCase(deps.sprintRepo);
      const result = await uc.execute({
        name: sprintName,
        slug,
        now: IsoTimestamp.now(),
      });
      if (!result.ok) throw new Error(result.error.message);

      // Auto-set as current sprint in config.
      const configLoaded = await deps.configStore.load();
      if (configLoaded.ok) {
        await deps.configStore.save({ ...configLoaded.value, currentSprint: result.value.id });
      }

      return result.value;
    });
  }, [run, router]);

  useInput((input, key) => {
    if (phase.kind !== 'done') return;

    if (phase.error === NO_PROJECTS_ERROR) {
      if (input === 'a') {
        router.replace({ id: 'project-add' });
        return;
      }
      if (key.return || key.escape) {
        router.pop();
      }
    } else {
      if (key.return) router.pop();
    }
  });

  return (
    <ViewShell title="CREATE SPRINT">
      {phase.kind === 'idle' || phase.kind === 'running' ? (
        <Spinner label={phase.kind === 'running' ? phase.label : 'Starting…'} />
      ) : phase.error !== null ? (
        phase.error === NO_PROJECTS_ERROR ? (
          <ResultCard
            kind="warning"
            title="No projects yet"
            lines={['Add a project before creating a sprint.']}
            nextSteps={[{ action: 'Press a to add a project' }, { action: 'Press Esc to go back' }]}
          />
        ) : (
          <ResultCard
            kind="error"
            title="Failed to create sprint"
            lines={[phase.error]}
            {...(phase.hint !== undefined ? { hint: phase.hint } : {})}
            nextSteps={[{ action: 'Press Enter to go back' }]}
          />
        )
      ) : (
        <ResultCard
          kind="success"
          title="Sprint created!"
          fields={[
            ['ID', String(phase.value.id)],
            ['Name', phase.value.name],
            ['Status', phase.value.status.toUpperCase()],
          ]}
          nextSteps={[
            { action: 'Add tickets', description: "select 'Add ticket' from the menu" },
            { action: 'Press Enter to go back' },
          ]}
        />
      )}
    </ViewShell>
  );
}
