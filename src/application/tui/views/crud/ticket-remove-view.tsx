/**
 * TicketRemoveView — remove a ticket from the current sprint.
 *
 * Prompts user to select ticket, confirms deletion, then calls RemoveTicketUseCase.
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
import { runSelectConfirmRemove } from '../../components/run-select-confirm-remove.ts';
import { resolveCurrentSprintId } from '../../components/resolve-current-sprint.ts';
import { getSharedDeps, getPrompt } from '../../../bootstrap/get-shared-deps.ts';
import { RemoveTicketUseCase } from '../../../../business/usecases/ticket/remove-ticket.ts';
import { ShowSprintUseCase } from '../../../../business/usecases/sprint/show-sprint.ts';
import { TicketId } from '../../../../domain/values/ticket-id.ts';

const HINTS = [{ key: 'Enter', action: 'confirm (terminal state)' }] as const;

export function TicketRemoveView(): React.JSX.Element {
  useViewHints(HINTS);
  const router = useRouter();
  const { phase, run } = useWorkflow<string>();

  useEffect(() => {
    run('Removing ticket…', async (setStep) => {
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
      const uc = new RemoveTicketUseCase(deps.sprintRepo);
      const removed = await runSelectConfirmRemove({
        prompt,
        router,
        items: sprint.tickets,
        selectMessage: 'Select ticket to remove',
        itemLabel: (t) => t.title,
        itemId: (t) => String(t.id),
        confirmMessage: (t) => `Remove ticket "${t.title}"?`,
        remove: async (id) => {
          const ticketIdResult = TicketId.parse(id);
          if (!ticketIdResult.ok) throw new Error(ticketIdResult.error.message);
          setStep('Removing ticket…');
          const result = await uc.execute({ sprintId: idResult.value, ticketId: ticketIdResult.value });
          if (!result.ok) throw new Error(result.error.message);
        },
      });

      return removed.title;
    });
  }, [run, router]);

  useInput((_input, key) => {
    if (phase.kind === 'done' && key.return) router.pop();
  });

  return (
    <ViewShell title="REMOVE TICKET">
      {phase.kind === 'idle' || phase.kind === 'running' ? (
        <Spinner label={phase.kind === 'running' ? phase.label : 'Starting…'} />
      ) : phase.error !== null ? (
        <ResultCard
          kind="error"
          title="Failed to remove ticket"
          lines={[phase.error]}
          {...(phase.hint !== undefined ? { hint: phase.hint } : {})}
          nextSteps={[{ action: 'Press Enter to go back' }]}
        />
      ) : (
        <ResultCard
          kind="success"
          title="Ticket removed!"
          fields={[['Title', phase.value]]}
          nextSteps={[{ action: 'Press Enter to go back' }]}
        />
      )}
    </ViewShell>
  );
}
