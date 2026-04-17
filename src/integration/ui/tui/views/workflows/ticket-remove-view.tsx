/**
 * TicketRemoveView — native Ink flow for `ticket remove`.
 *
 * Pick a ticket → confirm → remove from persistence.
 */

import React, { useMemo } from 'react';
import { getPrompt } from '@src/integration/bootstrap.ts';
import { getCurrentSprintOrThrow } from '@src/integration/persistence/sprint.ts';
import { listTickets, removeTicket } from '@src/integration/persistence/ticket.ts';
import { ResultCard } from '@src/integration/ui/tui/components/result-card.tsx';
import { Spinner } from '@src/integration/ui/tui/components/spinner.tsx';
import { ViewShell } from '@src/integration/ui/tui/components/view-shell.tsx';
import { useViewHints } from '@src/integration/ui/tui/views/view-hints-context.tsx';
import { useWorkflow } from './use-workflow.ts';

const TITLE = 'Remove Ticket' as const;

const HINTS_RUNNING = [{ key: 'Esc', action: 'cancel' }] as const;
const HINTS_DONE = [
  { key: 'Enter', action: 'home' },
  { key: 'Esc', action: 'back' },
] as const;

type Phase =
  | { kind: 'running'; step: 'select' | 'confirm' | 'removing' }
  | { kind: 'no-tickets' }
  | { kind: 'no-draft-sprint' }
  | { kind: 'cancelled' }
  | { kind: 'done'; id: string; title: string }
  | { kind: 'error'; message: string };

export function TicketRemoveView(): React.JSX.Element {
  const { phase } = useWorkflow<Phase>({
    initial: { kind: 'running', step: 'select' },
    onError: (message) => ({ kind: 'error', message }),
    run: async ({ setPhase }) => {
      const prompt = getPrompt();

      const sprint = await getCurrentSprintOrThrow();
      if (sprint.status !== 'draft') {
        setPhase({ kind: 'no-draft-sprint' });
        return;
      }

      const tickets = await listTickets();
      if (tickets.length === 0) {
        setPhase({ kind: 'no-tickets' });
        return;
      }

      setPhase({ kind: 'running', step: 'select' });
      const ticketId = await prompt.select<string>({
        message: 'Select ticket to remove:',
        choices: tickets.map((t) => ({
          label: `${t.id} — ${t.title}`,
          value: t.id,
          description: t.requirementStatus,
        })),
      });
      const target = tickets.find((t) => t.id === ticketId);
      if (!target) throw new Error(`Ticket ${ticketId} disappeared`);

      setPhase({ kind: 'running', step: 'confirm' });
      const ok = await prompt.confirm({
        message: `Remove ticket "${target.title}"? This cannot be undone.`,
        default: false,
      });
      if (!ok) {
        setPhase({ kind: 'cancelled' });
        return;
      }

      setPhase({ kind: 'running', step: 'removing' });
      await removeTicket(ticketId);
      setPhase({ kind: 'done', id: target.id, title: target.title });
    },
  });

  const hints = useMemo(() => (phase.kind === 'running' ? HINTS_RUNNING : HINTS_DONE), [phase.kind]);
  useViewHints(hints);

  return <ViewShell title={TITLE}>{renderBody(phase)}</ViewShell>;
}

function renderBody(phase: Phase): React.JSX.Element {
  switch (phase.kind) {
    case 'running':
      return <Spinner label={stepLabel(phase.step)} />;
    case 'no-tickets':
      return <ResultCard kind="info" title="No tickets to remove" />;
    case 'no-draft-sprint':
      return <ResultCard kind="warning" title="Current sprint is not a draft" />;
    case 'cancelled':
      return <ResultCard kind="info" title="Removal cancelled" />;
    case 'error':
      return <ResultCard kind="error" title="Could not remove ticket" lines={[phase.message]} />;
    case 'done':
      return (
        <ResultCard
          kind="success"
          title="Ticket removed"
          fields={[
            ['ID', phase.id],
            ['Title', phase.title],
          ]}
        />
      );
  }
}

function stepLabel(step: 'select' | 'confirm' | 'removing'): string {
  if (step === 'select') return 'Awaiting ticket selection…';
  if (step === 'confirm') return 'Awaiting confirmation…';
  return 'Removing ticket…';
}
