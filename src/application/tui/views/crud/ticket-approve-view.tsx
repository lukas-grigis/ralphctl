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
import { ApproveTicketRequirementsUseCase } from '@src/business/usecases/ticket/approve-ticket.ts';
import { ShowSprintUseCase } from '@src/business/usecases/sprint/show-sprint.ts';
import { TicketId } from '@src/domain/values/ticket-id.ts';
import type { Sprint } from '@src/domain/entities/sprint.ts';

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
      const idResult = await resolveCurrentSprintId(deps.configStore);
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
        pickedTicketId = await promptOrPop(router, () =>
          prompt.select<string>({
            message: 'Select ticket to approve',
            choices: pending.map((t) => ({
              label: t.title,
              value: String(t.id),
            })),
          })
        );
      }

      const ticket = pending.find((t) => String(t.id) === pickedTicketId);
      if (!ticket) throw new Error('Ticket not found.');

      let requirements: string | undefined;
      let editorError: string | null = null;
      while (requirements === undefined) {
        setStep(editorError !== null ? `${editorError} — try again…` : 'Awaiting requirements…');
        const raw = await promptOrPop(router, () =>
          prompt.editor({
            message: 'Requirements (Ctrl+D to submit, Esc to cancel)',
          })
        );
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
  }, [run, router, ticketId]);

  useViewInput((_input, key) => {
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
