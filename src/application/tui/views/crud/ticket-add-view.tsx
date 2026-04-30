/**
 * TicketAddView — add a ticket to the current sprint.
 *
 * Prompts:
 *   1. Project (select from existing projects)
 *   2. Title (input)
 *   3. Description (optional editor)
 *   4. Link (optional input)
 *
 * Calls AddTicketUseCase. Shows ResultCard on terminal state.
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
import { AddTicketUseCase } from '../../../../business/usecases/ticket/add-ticket.ts';
import { ListProjectsUseCase } from '../../../../business/usecases/project/list-projects.ts';
import { SprintId } from '../../../../domain/values/sprint-id.ts';
import { ProjectName } from '../../../../domain/values/project-name.ts';
import { PromptCancelledError } from '../../../ui/prompt-cancelled-error.ts';
import type { Sprint } from '../../../../domain/entities/sprint.ts';

const HINTS = [{ key: 'Enter', action: 'confirm (terminal state)' }] as const;

export function TicketAddView(): React.JSX.Element {
  useViewHints(HINTS);
  const router = useRouter();
  const { phase, run } = useWorkflow<Sprint>();

  useEffect(() => {
    run('Adding ticket…', async (setStep) => {
      const deps = await getSharedDeps();
      const config = await deps.configStore.load();
      if (!config.ok) throw new Error(config.error.message);
      const sprintIdStr = config.value.currentSprint;
      if (!sprintIdStr) throw new Error('No current sprint. Set one via Settings.');
      const idResult = SprintId.parse(sprintIdStr);
      if (!idResult.ok) throw new Error(idResult.error.message);

      setStep('Loading projects…');
      const projectsUc = new ListProjectsUseCase(deps.projectRepo);
      const projectsResult = await projectsUc.execute();
      if (!projectsResult.ok) throw new Error(projectsResult.error.message);
      if (projectsResult.value.length === 0) throw new Error('No projects found. Add a project first.');

      const prompt = await getPrompt();
      setStep('Awaiting project selection…');
      let projectNameStr: string;
      try {
        projectNameStr = await prompt.select<string>({
          message: 'Project',
          choices: projectsResult.value.map((p) => ({
            label: `${p.displayName} (${String(p.name)})`,
            value: String(p.name),
          })),
        });
      } catch (err) {
        if (err instanceof PromptCancelledError) {
          router.pop();
          throw err;
        }
        throw err;
      }

      let ticketTitle: string | undefined;
      let titleError: string | null = null;
      while (ticketTitle === undefined) {
        setStep(titleError !== null ? `${titleError} — try again…` : 'Awaiting ticket title…');
        let rawTitle: string;
        try {
          rawTitle = (await prompt.input({ message: 'Title', default: '' })).trim();
        } catch (err) {
          if (err instanceof PromptCancelledError) {
            router.pop();
            throw err;
          }
          throw err;
        }
        if (rawTitle === '') {
          titleError = 'Title cannot be empty';
        } else {
          ticketTitle = rawTitle;
        }
      }
      const title: string = ticketTitle;

      setStep('Awaiting description…');
      let description: string | undefined;
      try {
        const raw = await prompt.editor({ message: 'Description (optional — Ctrl+D to skip)' });
        description = raw?.trim() ?? undefined;
      } catch (err) {
        if (err instanceof PromptCancelledError) description = undefined;
        else throw err;
      }

      setStep('Awaiting link…');
      let link: string | undefined;
      try {
        const raw = await prompt.input({ message: 'Link (optional URL, leave blank to skip)', default: '' });
        link = raw.trim() !== '' ? raw.trim() : undefined;
      } catch (err) {
        if (err instanceof PromptCancelledError) {
          router.pop();
          throw err;
        }
        throw err;
      }

      const projectNameResult = ProjectName.parse(projectNameStr);
      if (!projectNameResult.ok) throw new Error(projectNameResult.error.message);

      setStep('Saving ticket…');
      const uc = new AddTicketUseCase(deps.sprintRepo);
      const result = await uc.execute({
        sprintId: idResult.value,
        ticketInput: {
          title,
          projectName: projectNameResult.value,
          ...(description !== undefined ? { description } : {}),
          ...(link !== undefined ? { link } : {}),
        },
      });
      if (!result.ok) throw new Error(result.error.message);
      return result.value;
    });
  }, []);

  useInput((_input, key) => {
    if (phase.kind === 'done' && key.return) router.pop();
  });

  return (
    <ViewShell title="ADD TICKET">
      {phase.kind === 'idle' || phase.kind === 'running' ? (
        <Spinner label={phase.kind === 'running' ? phase.label : 'Starting…'} />
      ) : phase.error !== null ? (
        <ResultCard
          kind="error"
          title="Failed to add ticket"
          lines={[phase.error]}
          {...(phase.hint !== undefined ? { hint: phase.hint } : {})}
          nextSteps={[{ action: 'Press Enter to go back' }]}
        />
      ) : (
        <ResultCard
          kind="success"
          title="Ticket added!"
          fields={[
            ['Sprint', String(phase.value.id)],
            ['Tickets', String(phase.value.tickets.length)],
          ]}
          nextSteps={[
            { action: 'Refine requirements', description: 'run sprint refine' },
            { action: 'Press Enter to go back' },
          ]}
        />
      )}
    </ViewShell>
  );
}
