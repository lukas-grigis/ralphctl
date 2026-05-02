/**
 * TicketEditView — edit a ticket in the current sprint.
 *
 * Prompts user to select ticket, then edit title / description / link.
 * Calls EditTicketUseCase.
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
import { EditTicketUseCase } from '@src/business/usecases/ticket/edit-ticket.ts';
import { ShowSprintUseCase } from '@src/business/usecases/sprint/show-sprint.ts';
import { TicketId } from '@src/domain/values/ticket-id.ts';
import { PromptCancelledError } from '@src/business/ports/prompt-port.ts';
import type { Sprint } from '@src/domain/entities/sprint.ts';

const HINTS = [{ key: 'Enter', action: 'confirm (terminal state)' }] as const;

export function TicketEditView(): React.JSX.Element {
  useViewHints(HINTS);
  const router = useRouter();
  const { phase, run } = useWorkflow<Sprint>();

  useEffect(() => {
    run('Editing ticket…', async (setStep) => {
      const deps = await getSharedDeps();
      const idResult = await resolveCurrentSprintId(deps.configStore);
      if (!idResult.ok) throw new Error(idResult.error.message);

      setStep('Loading sprint…');
      const showUc = new ShowSprintUseCase(deps.sprintRepo);
      const sprintResult = await showUc.execute({ id: idResult.value });
      if (!sprintResult.ok) throw new Error(sprintResult.error.message);
      const sprint = sprintResult.value;
      if (sprint.tickets.length === 0) throw new Error('No tickets in current sprint.');

      const prompt = await getPrompt();
      setStep('Awaiting ticket selection…');
      const ticketIdStr = await promptOrPop(router, () =>
        prompt.select<string>({
          message: 'Select ticket to edit',
          choices: sprint.tickets.map((t) => ({
            label: `${t.title} [${t.requirementStatus}]`,
            value: String(t.id),
          })),
        })
      );

      const ticket = sprint.tickets.find((t) => String(t.id) === ticketIdStr);
      if (!ticket) throw new Error('Ticket not found.');

      setStep('Awaiting new title…');
      const title = await promptOrPop(router, () => prompt.input({ message: 'Title', default: ticket.title }));

      setStep('Awaiting description…');
      let description: string | undefined;
      try {
        const raw = await prompt.editor({ message: 'Description (Ctrl+D to keep existing)' });
        description = raw !== null ? (raw.trim() !== '' ? raw.trim() : undefined) : ticket.description;
      } catch (err) {
        if (err instanceof PromptCancelledError) description = ticket.description;
        else throw err;
      }

      const ticketIdResult = TicketId.parse(ticketIdStr);
      if (!ticketIdResult.ok) throw new Error(ticketIdResult.error.message);

      setStep('Saving ticket…');
      const uc = new EditTicketUseCase(deps.sprintRepo);
      const result = await uc.execute({
        sprintId: idResult.value,
        ticketId: ticketIdResult.value,
        partial: {
          title: title.trim(),
          ...(description !== undefined ? { description } : {}),
        },
      });
      if (!result.ok) throw new Error(result.error.message);
      return result.value;
    });
  }, [run, router]);

  useViewInput((_input, key) => {
    if (phase.kind === 'done' && key.return) router.pop();
  });

  return (
    <ViewShell title="EDIT TICKET">
      {phase.kind === 'idle' || phase.kind === 'running' ? (
        <Spinner label={phase.kind === 'running' ? phase.label : 'Starting…'} />
      ) : phase.error !== null ? (
        <ResultCard
          kind="error"
          title="Failed to edit ticket"
          lines={[phase.error]}
          {...(phase.hint !== undefined ? { hint: phase.hint } : {})}
          nextSteps={[{ action: 'Press Enter to go back' }]}
        />
      ) : (
        <ResultCard kind="success" title="Ticket updated!" nextSteps={[{ action: 'Press Enter to go back' }]} />
      )}
    </ViewShell>
  );
}
