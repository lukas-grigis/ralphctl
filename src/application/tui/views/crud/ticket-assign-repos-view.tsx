/**
 * TicketAssignReposView — manually assign affected repository paths to a
 * ticket via a checkbox picker.
 *
 * Normally `sprint plan` does this when the user picks repos for an
 * approved ticket. This view exposes the underlying use case directly so
 * a user can amend the list without re-running planning.
 *
 * Prompts: select ticket → checkbox of every repo across every project,
 * pre-checked with the ticket's current `affectedRepositories`. Calls
 * `AssignTicketRepositoriesUseCase`.
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
import { AssignTicketRepositoriesUseCase } from '../../../../business/usecases/ticket/assign-ticket-repositories.ts';
import { ListProjectsUseCase } from '../../../../business/usecases/project/list-projects.ts';
import { ShowSprintUseCase } from '../../../../business/usecases/sprint/show-sprint.ts';
import { AbsolutePath } from '../../../../domain/values/absolute-path.ts';
import { SprintId } from '../../../../domain/values/sprint-id.ts';
import { TicketId } from '../../../../domain/values/ticket-id.ts';
import { PromptCancelledError } from '../../../ui/prompt-cancelled-error.ts';
import type { Sprint } from '../../../../domain/entities/sprint.ts';

const HINTS = [{ key: 'Enter', action: 'confirm (terminal state)' }] as const;

interface Props {
  readonly ticketId?: string;
}

export function TicketAssignReposView({ ticketId }: Props = {}): React.JSX.Element {
  useViewHints(HINTS);
  const router = useRouter();
  const { phase, run } = useWorkflow<Sprint>();

  useEffect(() => {
    run('Assigning repositories…', async (setStep) => {
      const deps = await getSharedDeps();
      const config = await deps.configStore.load();
      if (!config.ok) throw new Error(config.error.message);
      const sprintIdStr = config.value.currentSprint;
      if (!sprintIdStr) throw new Error('No current sprint. Set one via Settings.');
      const idResult = SprintId.parse(sprintIdStr);
      if (!idResult.ok) throw new Error(idResult.error.message);

      setStep('Loading sprint…');
      const showUc = new ShowSprintUseCase(deps.sprintRepo);
      const sprintResult = await showUc.execute({ id: idResult.value });
      if (!sprintResult.ok) throw new Error(sprintResult.error.message);
      const sprint = sprintResult.value;
      if (sprint.tickets.length === 0) throw new Error('No tickets in current sprint.');

      const prompt = await getPrompt();

      let pickedTicketId: string;
      if (ticketId !== undefined) {
        pickedTicketId = ticketId;
      } else {
        setStep('Awaiting ticket selection…');
        try {
          pickedTicketId = await prompt.select<string>({
            message: 'Select ticket',
            choices: sprint.tickets.map((t) => ({
              label: `${t.title} [${t.requirementStatus}]`,
              value: String(t.id),
            })),
          });
        } catch (err) {
          if (err instanceof PromptCancelledError) {
            router.pop();
            throw err;
          }
          throw err;
        }
      }

      const ticket = sprint.tickets.find((t) => String(t.id) === pickedTicketId);
      if (!ticket) throw new Error('Ticket not found.');

      setStep('Loading projects…');
      const projectsUc = new ListProjectsUseCase(deps.projectRepo);
      const projectsResult = await projectsUc.execute();
      if (!projectsResult.ok) throw new Error(projectsResult.error.message);

      const repoChoices = projectsResult.value.flatMap((p) =>
        p.repositories.map((r) => ({
          label: `${p.displayName} — ${r.name} (${r.path})`,
          value: r.path,
        }))
      );
      if (repoChoices.length === 0) throw new Error('No repositories registered. Add a project first.');

      const currentSelection = ticket.affectedRepositories ?? [];
      const defaults = currentSelection.map((p) => String(p));

      setStep('Awaiting repo selection…');
      let selected: string[];
      try {
        selected = await prompt.checkbox<string>({
          message: 'Select affected repositories',
          choices: repoChoices,
          defaults,
        });
      } catch (err) {
        if (err instanceof PromptCancelledError) {
          router.pop();
          throw err;
        }
        throw err;
      }

      const paths: AbsolutePath[] = [];
      for (const raw of selected) {
        const parsed = AbsolutePath.parse(raw);
        if (!parsed.ok) throw new Error(parsed.error.message);
        paths.push(parsed.value);
      }

      const tidResult = TicketId.parse(pickedTicketId);
      if (!tidResult.ok) throw new Error(tidResult.error.message);

      setStep('Saving assignment…');
      const uc = new AssignTicketRepositoriesUseCase(deps.sprintRepo);
      const result = await uc.execute({
        sprintId: idResult.value,
        ticketId: tidResult.value,
        paths,
      });
      if (!result.ok) throw new Error(result.error.message);
      return result.value;
    });
  }, [run, router, ticketId]);

  useInput((_input, key) => {
    if (phase.kind === 'done' && key.return) router.pop();
  });

  return (
    <ViewShell title="ASSIGN REPOSITORIES">
      {phase.kind === 'idle' || phase.kind === 'running' ? (
        <Spinner label={phase.kind === 'running' ? phase.label : 'Starting…'} />
      ) : phase.error !== null ? (
        <ResultCard
          kind="error"
          title="Failed to assign repositories"
          lines={[phase.error]}
          {...(phase.hint !== undefined ? { hint: phase.hint } : {})}
          nextSteps={[{ action: 'Press Enter to go back' }]}
        />
      ) : (
        <ResultCard kind="success" title="Repositories assigned!" nextSteps={[{ action: 'Press Enter to go back' }]} />
      )}
    </ViewShell>
  );
}
