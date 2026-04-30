/**
 * TicketApproveView — manually approve a ticket's requirements.
 *
 * Normally `sprint refine` does this via AI clarification, but this view
 * exposes the underlying use case so a user can paste / type requirements
 * directly. Useful for tickets that don't need refinement, or to recover
 * from a failed refinement run.
 *
 * Prompts: select ticket (only `pending` shown) → multi-line editor for
 * requirements text. Calls `ApproveTicketRequirementsUseCase`.
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
import { ApproveTicketRequirementsUseCase } from '../../../../business/usecases/ticket/approve-ticket.ts';
import { ShowSprintUseCase } from '../../../../business/usecases/sprint/show-sprint.ts';
import { SprintId } from '../../../../domain/values/sprint-id.ts';
import { TicketId } from '../../../../domain/values/ticket-id.ts';
import { PromptCancelledError } from '../../../ui/prompt-cancelled-error.ts';
import type { Sprint } from '../../../../domain/entities/sprint.ts';

const HINTS = [{ key: 'Enter', action: 'confirm (terminal state)' }] as const;

interface Props {
  readonly ticketId?: string;
}

export function TicketApproveView({ ticketId }: Props = {}): React.JSX.Element {
  useViewHints(HINTS);
  const router = useRouter();
  const { phase, run } = useWorkflow<Sprint>();

  useEffect(() => {
    run('Approving requirements…', async (setStep) => {
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
      const pending = sprint.tickets.filter((t) => t.requirementStatus === 'pending');
      if (pending.length === 0) throw new Error('No pending tickets in current sprint.');

      const prompt = await getPrompt();

      let pickedTicketId: string;
      if (ticketId !== undefined) {
        const found = pending.find((t) => String(t.id) === ticketId);
        if (!found) throw new Error('Ticket not found, or it is not pending.');
        pickedTicketId = ticketId;
      } else {
        setStep('Awaiting ticket selection…');
        try {
          pickedTicketId = await prompt.select<string>({
            message: 'Select ticket to approve',
            choices: pending.map((t) => ({
              label: `${t.title} (${String(t.projectName)})`,
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

      const ticket = pending.find((t) => String(t.id) === pickedTicketId);
      if (!ticket) throw new Error('Ticket not found.');

      let requirements: string | undefined;
      let editorError: string | null = null;
      while (requirements === undefined) {
        setStep(editorError !== null ? `${editorError} — try again…` : 'Awaiting requirements…');
        try {
          const raw = await prompt.editor({
            message: 'Requirements (Ctrl+D to submit, Esc to cancel)',
          });
          if (raw === null) {
            router.pop();
            return sprint; // unreachable — pop ends the flow
          }
          const trimmed = raw.trim();
          if (trimmed.length === 0) {
            editorError = 'Requirements cannot be empty';
            continue;
          }
          requirements = trimmed;
        } catch (err) {
          if (err instanceof PromptCancelledError) {
            router.pop();
            throw err;
          }
          throw err;
        }
      }

      const tidResult = TicketId.parse(pickedTicketId);
      if (!tidResult.ok) throw new Error(tidResult.error.message);

      setStep('Saving approval…');
      const uc = new ApproveTicketRequirementsUseCase(deps.sprintRepo);
      const result = await uc.execute({
        sprintId: idResult.value,
        ticketId: tidResult.value,
        requirements,
      });
      if (!result.ok) throw new Error(result.error.message);
      return result.value;
    });
  }, [ticketId]);

  useInput((_input, key) => {
    if (phase.kind === 'done' && key.return) router.pop();
  });

  return (
    <ViewShell title="APPROVE TICKET">
      {phase.kind === 'idle' || phase.kind === 'running' ? (
        <Spinner label={phase.kind === 'running' ? phase.label : 'Starting…'} />
      ) : phase.error !== null ? (
        <ResultCard
          kind="error"
          title="Failed to approve ticket"
          lines={[phase.error]}
          {...(phase.hint !== undefined ? { hint: phase.hint } : {})}
          nextSteps={[{ action: 'Press Enter to go back' }]}
        />
      ) : (
        <ResultCard kind="success" title="Ticket approved!" nextSteps={[{ action: 'Press Enter to go back' }]} />
      )}
    </ViewShell>
  );
}
