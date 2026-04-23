/**
 * TicketRemoveView — native Ink flow for `ticket remove`.
 *
 * Validates draft-sprint state + picks a ticket; the shared
 * {@link RemovalWorkflow} owns the confirm + remove + done state machine.
 */

import React, { useEffect, useState } from 'react';
import { PromptCancelledError } from '@src/business/ports/prompt.ts';
import { getPrompt } from '@src/integration/bootstrap.ts';
import { getCurrentSprintOrThrow } from '@src/integration/persistence/sprint.ts';
import { listTickets, removeTicket } from '@src/integration/persistence/ticket.ts';
import { RemovalWorkflow } from '@src/integration/ui/tui/components/removal-workflow.tsx';
import { ResultCard } from '@src/integration/ui/tui/components/result-card.tsx';
import { Spinner } from '@src/integration/ui/tui/components/spinner.tsx';
import { ViewShell } from '@src/integration/ui/tui/components/view-shell.tsx';
import { useRouter } from '@src/integration/ui/tui/views/router-context.ts';

const TITLE = 'Remove Ticket' as const;

type Phase =
  | { kind: 'loading' }
  | { kind: 'selecting' }
  | { kind: 'no-tickets' }
  | { kind: 'no-draft-sprint' }
  | { kind: 'ready'; ticketId: string; ticketTitle: string }
  | { kind: 'error'; message: string };

export function TicketRemoveView(): React.JSX.Element {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [started, setStarted] = useState(false);

  useEffect(() => {
    if (started) return;
    setStarted(true);
    void (async (): Promise<void> => {
      try {
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

        setPhase({ kind: 'selecting' });
        const ticketId = await getPrompt().select<string>({
          message: 'Select ticket to remove:',
          choices: tickets.map((t) => ({
            label: `${t.id} — ${t.title}`,
            value: t.id,
            description: t.requirementStatus,
          })),
        });
        const target = tickets.find((t) => t.id === ticketId);
        if (!target) throw new Error(`Ticket ${ticketId} disappeared`);

        setPhase({ kind: 'ready', ticketId: target.id, ticketTitle: target.title });
      } catch (err) {
        if (err instanceof PromptCancelledError) {
          router.pop();
          return;
        }
        setPhase({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
      }
    })();
  }, [started, router]);

  if (phase.kind === 'ready') {
    return (
      <RemovalWorkflow
        entityLabel={TITLE}
        confirmMessage={`Remove ticket "${phase.ticketTitle}"? This cannot be undone.`}
        onConfirm={() => removeTicket(phase.ticketId)}
        successMessage={`Ticket "${phase.ticketTitle}" removed`}
        onDone={() => {
          router.pop();
        }}
      />
    );
  }

  return <ViewShell title={TITLE}>{renderPre(phase)}</ViewShell>;
}

function renderPre(phase: Exclude<Phase, { kind: 'ready' }>): React.JSX.Element {
  switch (phase.kind) {
    case 'loading':
      return <Spinner label="Loading tickets…" />;
    case 'selecting':
      return <Spinner label="Awaiting ticket selection…" />;
    case 'no-tickets':
      return <ResultCard kind="info" title="No tickets to remove" />;
    case 'no-draft-sprint':
      return <ResultCard kind="warning" title="Current sprint is not a draft" />;
    case 'error':
      return <ResultCard kind="error" title="Could not remove ticket" lines={[phase.message]} />;
  }
}
