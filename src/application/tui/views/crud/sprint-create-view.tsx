/**
 * SprintCreateView — interactive sprint creation form.
 *
 * Pre-flight: if no projects exist, shows a warning card instead of entering
 * the form — a sprint without a project is a dead-end.
 *
 * Prompts:
 *   1. Project (select — sprint-per-project is the architectural invariant)
 *   2. Sprint name (input, retries inline on empty)
 *   3. Slug (input, retries inline on invalid slug)
 *   4. Set as current sprint? (confirm, default Yes)
 *
 * On submit, calls CreateSprintUseCase then optionally sets currentSprint in
 * config. Shows ResultCard on success / error.
 *
 * Keyboard:
 *   Enter on success (setAsCurrent=true) → reset to Home.
 *   Enter on success (setAsCurrent=false) → pop one frame.
 *   a on no-projects warning → navigate to project-add.
 *   Esc / Enter on no-projects warning → go back.
 */

import React, { useEffect, useRef } from 'react';
import { useViewInput } from '@src/application/tui/views/use-view-input.ts';
import { ViewShell } from '@src/application/tui/components/view-shell.tsx';
import { Spinner } from '@src/application/tui/components/spinner.tsx';
import { ResultCard } from '@src/application/tui/components/result-card.tsx';
import { useViewHints } from '@src/application/tui/views/view-hints-context.tsx';
import { useRouter } from '@src/application/tui/views/router-context.ts';
import { useWorkflow } from '@src/application/tui/components/use-workflow.ts';
import { promptOrPop } from '@src/application/tui/components/prompt-or-pop.ts';
import { getSharedDeps, getPrompt } from '@src/application/bootstrap/get-shared-deps.ts';
import { CreateSprintUseCase } from '@src/business/usecases/sprint/create-sprint.ts';
import { ListProjectsUseCase } from '@src/business/usecases/project/list-projects.ts';
import { ProjectName } from '@src/domain/values/project-name.ts';
import { Slug } from '@src/domain/values/slug.ts';
import { IsoTimestamp } from '@src/domain/values/iso-timestamp.ts';
import type { Sprint } from '@src/domain/entities/sprint.ts';

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
  // Track whether the user chose to set the sprint as current so the
  // terminal-state Enter handler can route to Home (not the previous frame).
  const setAsCurrentRef = useRef(false);

  useEffect(() => {
    run('Creating sprint…', async (setStep) => {
      const deps = await getSharedDeps();

      // Pre-flight: require at least one project.
      setStep('Loading projects…');
      const listUc = new ListProjectsUseCase(deps.projectRepo);
      const projectsResult = await listUc.execute();
      if (!projectsResult.ok) throw new Error(projectsResult.error.message);
      if (projectsResult.value.length === 0) {
        throw new Error(NO_PROJECTS_ERROR);
      }

      const prompt = await getPrompt();

      // ── Project picker — required, sprint-per-project ───────────────
      setStep('Awaiting project selection…');
      const projectNameStr = await promptOrPop(router, () =>
        prompt.select<string>({
          message: 'Project',
          choices: projectsResult.value.map((p) => ({
            label: `${p.displayName} (${String(p.name)})`,
            value: String(p.name),
          })),
        })
      );
      const projectNameResult = ProjectName.parse(projectNameStr);
      if (!projectNameResult.ok) throw new Error(projectNameResult.error.message);
      const projectName = projectNameResult.value;

      let name: string | undefined;
      let nameError: string | null = null;
      while (name === undefined) {
        setStep(nameError !== null ? `${nameError} — try again…` : 'Awaiting sprint name…');
        const raw = (await promptOrPop(router, () => prompt.input({ message: 'Sprint name', default: '' }))).trim();
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
        const slugStr = await promptOrPop(router, () =>
          prompt.input({ message: 'Slug (lowercase alnum + hyphens)', default: suggested })
        );
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
        projectName,
      });
      if (!result.ok) throw new Error(result.error.message);

      // Confirm with the user (default Yes — Enter accepts) before flipping
      // the config pointer. Skipping the prompt would silently steal focus
      // from any sprint they were already working on.
      // The step label starts with "Awaiting" so the Spinner suppresses
      // itself while the prompt is active.
      setStep('Awaiting set-as-current confirmation…');
      const setAsCurrent = await promptOrPop(router, () =>
        deps.prompt.confirm({
          message: 'Set as current sprint?',
          default: true,
        })
      );
      setAsCurrentRef.current = setAsCurrent;
      if (setAsCurrent) {
        const configLoaded = await deps.configStore.load();
        if (configLoaded.ok) {
          await deps.configStore.save({ ...configLoaded.value, currentSprint: result.value.id });
        }
      }

      return result.value;
    });
  }, [run, router]);

  useViewInput((input, key) => {
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
      if (key.return) {
        // When the sprint was set as current, go all the way back to Home so
        // the pipeline map immediately reflects the new sprint. Popping one
        // frame would land the user back on the BROWSE submenu instead.
        if (setAsCurrentRef.current) {
          router.reset({ id: 'home' });
        } else {
          router.pop();
        }
      }
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
            ['Project', String(phase.value.projectName)],
            ['Status', phase.value.status.toUpperCase()],
          ]}
          nextSteps={[
            { action: 'Add tickets', description: 'b → Tickets → Add' },
            { action: 'Press Enter to go to Home' },
          ]}
        />
      )}
    </ViewShell>
  );
}
