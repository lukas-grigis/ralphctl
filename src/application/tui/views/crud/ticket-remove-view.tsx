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
import { getSharedDeps, getPrompt } from '../../../bootstrap/get-shared-deps.ts';
import { RemoveTicketUseCase } from '../../../../business/usecases/ticket/remove-ticket.ts';
import { ShowSprintUseCase } from '../../../../business/usecases/sprint/show-sprint.ts';
import { SprintId } from '../../../../domain/values/sprint-id.ts';
import { TicketId } from '../../../../domain/values/ticket-id.ts';
import { PromptCancelledError } from '../../../ui/prompt-cancelled-error.ts';

const HINTS = [{ key: 'Enter', action: 'confirm (terminal state)' }] as const;

export function TicketRemoveView(): React.JSX.Element {
  useViewHints(HINTS);
  const router = useRouter();
  const { phase, run } = useWorkflow<string>();

  useEffect(() => {
    run('Removing ticket…', async (setStep) => {
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
      setStep('Awaiting ticket selection…');
      let ticketIdStr: string;
      try {
        ticketIdStr = await prompt.select<string>({
          message: 'Select ticket to remove',
          choices: sprint.tickets.map((t) => ({
            label: t.title,
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

      const ticket = sprint.tickets.find((t) => String(t.id) === ticketIdStr);
      const ticketTitle = ticket?.title ?? ticketIdStr;

      setStep('Awaiting confirmation…');
      let confirmed: boolean;
      try {
        confirmed = await prompt.confirm({
          message: `Remove ticket "${ticketTitle}"?`,
          default: false,
        });
      } catch (err) {
        if (err instanceof PromptCancelledError) {
          router.pop();
          throw err;
        }
        throw err;
      }
      if (!confirmed) {
        router.pop();
        throw new Error('Cancelled.');
      }

      const ticketIdResult = TicketId.parse(ticketIdStr);
      if (!ticketIdResult.ok) throw new Error(ticketIdResult.error.message);

      setStep('Removing ticket…');
      const uc = new RemoveTicketUseCase(deps.sprintRepo);
      const result = await uc.execute({ sprintId: idResult.value, ticketId: ticketIdResult.value });
      if (!result.ok) throw new Error(result.error.message);

      return ticketTitle;
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
