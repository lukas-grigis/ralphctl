/**
 * TicketRefineView — native Ink entry point for re-refining a single ticket.
 *
 * The actual AI session is still driven by `ticketRefineCommand` — it spawns
 * an interactive Claude/Copilot session that wants full terminal control.
 * We use `withSuspendedTui` to step Ink aside for the duration, then show a
 * summary card on return.
 *
 * This is the "native wrapper" pattern: keep the proven CLI command as the
 * engine, give the TUI a clean frame around it.
 */

import React, { useMemo } from 'react';
import { getPrompt } from '@src/integration/bootstrap.ts';
import { getCurrentSprintOrThrow } from '@src/integration/persistence/sprint.ts';
import { listTickets } from '@src/integration/persistence/ticket.ts';
import { withSuspendedTui } from '@src/integration/ui/tui/runtime/suspend.ts';
import { ticketRefineCommand } from '@src/integration/cli/commands/ticket/refine.ts';
import { ResultCard } from '@src/integration/ui/tui/components/result-card.tsx';
import { Spinner } from '@src/integration/ui/tui/components/spinner.tsx';
import { ViewShell } from '@src/integration/ui/tui/components/view-shell.tsx';
import { useViewHints } from '@src/integration/ui/tui/views/view-hints-context.tsx';
import { useWorkflow } from './use-workflow.ts';

const TITLE = 'Re-Refine Ticket' as const;

const HINTS_RUNNING = [{ key: 'Esc', action: 'cancel' }] as const;
const HINTS_DONE = [
  { key: 'Enter', action: 'home' },
  { key: 'Esc', action: 'back' },
] as const;

type Phase =
  | { kind: 'running'; step: 'select' | 'suspended' }
  | { kind: 'no-approved' }
  | { kind: 'no-draft-sprint' }
  | { kind: 'done'; ticketTitle: string }
  | { kind: 'error'; message: string };

export function TicketRefineView(): React.JSX.Element {
  const { phase } = useWorkflow<Phase>({
    initial: { kind: 'running', step: 'select' },
    onError: (message) => ({ kind: 'error', message }),
    run: async ({ setPhase }) => {
      const sprint = await getCurrentSprintOrThrow();
      if (sprint.status !== 'draft') {
        setPhase({ kind: 'no-draft-sprint' });
        return;
      }

      const tickets = await listTickets();
      const approved = tickets.filter((t) => t.requirementStatus === 'approved');
      if (approved.length === 0) {
        setPhase({ kind: 'no-approved' });
        return;
      }

      setPhase({ kind: 'running', step: 'select' });
      const ticketId = await getPrompt().select<string>({
        message: 'Re-refine which ticket?',
        choices: approved.map((t) => ({ label: `${t.id} — ${t.title}`, value: t.id })),
      });
      const target = approved.find((t) => t.id === ticketId);
      if (!target) throw new Error(`Ticket ${ticketId} disappeared`);

      setPhase({ kind: 'running', step: 'suspended' });
      await withSuspendedTui(() => ticketRefineCommand(ticketId, { interactive: true }));

      setPhase({ kind: 'done', ticketTitle: target.title });
    },
  });

  const hints = useMemo(() => (phase.kind === 'running' ? HINTS_RUNNING : HINTS_DONE), [phase.kind]);
  useViewHints(hints);

  return <ViewShell title={TITLE}>{renderBody(phase)}</ViewShell>;
}

function renderBody(phase: Phase): React.JSX.Element {
  switch (phase.kind) {
    case 'running':
      return <Spinner label={phase.step === 'select' ? 'Awaiting ticket selection…' : 'Running AI session…'} />;
    case 'no-draft-sprint':
      return <ResultCard kind="warning" title="Current sprint is not a draft" />;
    case 'no-approved':
      return (
        <ResultCard
          kind="warning"
          title="No approved tickets to re-refine"
          lines={['Run refine on Home first to approve ticket requirements.']}
        />
      );
    case 'error':
      return <ResultCard kind="error" title="Re-refinement failed" lines={[phase.message]} />;
    case 'done':
      return (
        <ResultCard
          kind="success"
          title="Re-refinement finished"
          fields={[['Ticket', phase.ticketTitle]]}
          lines={['Check the sprint submenu → Tickets → Show to see updated requirements.']}
        />
      );
  }
}
