/**
 * TicketEditView — native Ink flow for `ticket edit`.
 *
 * Pick a ticket → pick a field to edit (title / description / link) → apply
 * the change via persistence. Multi-line description uses the editor prompt.
 */

import React, { useMemo } from 'react';
import type { Ticket } from '@src/domain/models.ts';
import { getPrompt } from '@src/application/bootstrap.ts';
import { getCurrentSprintOrThrow } from '@src/integration/persistence/sprint.ts';
import { listTickets, updateTicket } from '@src/integration/persistence/ticket.ts';
import { ResultCard } from '@src/integration/ui/tui/components/result-card.tsx';
import { Spinner } from '@src/integration/ui/tui/components/spinner.tsx';
import { ViewShell } from '@src/integration/ui/tui/components/view-shell.tsx';
import { useViewHints } from '@src/integration/ui/tui/views/view-hints-context.tsx';
import { useWorkflow } from './use-workflow.ts';

const TITLE = 'Edit Ticket' as const;

const HINTS_RUNNING = [{ key: 'Esc', action: 'cancel' }] as const;
const HINTS_DONE = [
  { key: 'Enter', action: 'home' },
  { key: 'Esc', action: 'back' },
] as const;

type FieldChoice = 'title' | 'description' | 'link';

type Phase =
  | { kind: 'running'; step: 'select-ticket' | 'select-field' | 'edit' | 'saving' }
  | { kind: 'no-tickets' }
  | { kind: 'no-draft-sprint' }
  | { kind: 'done'; ticket: Ticket; field: FieldChoice }
  | { kind: 'error'; message: string };

export function TicketEditView(): React.JSX.Element {
  const { phase } = useWorkflow<Phase>({
    initial: { kind: 'running', step: 'select-ticket' },
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

      setPhase({ kind: 'running', step: 'select-ticket' });
      const ticketId = await prompt.select<string>({
        message: 'Select ticket to edit:',
        choices: tickets.map((t) => ({
          label: `${t.id} — ${t.title}`,
          value: t.id,
          description: `${t.projectName} · ${t.requirementStatus}`,
        })),
      });
      const current = tickets.find((t) => t.id === ticketId);
      if (!current) throw new Error(`Ticket ${ticketId} disappeared`);

      setPhase({ kind: 'running', step: 'select-field' });
      const field = await prompt.select<FieldChoice>({
        message: 'Which field?',
        choices: [
          { label: 'Title', value: 'title', description: current.title },
          { label: 'Description', value: 'description', description: current.description ?? '(empty)' },
          { label: 'Link', value: 'link', description: current.link ?? '(empty)' },
        ],
      });

      setPhase({ kind: 'running', step: 'edit' });
      let updatedValue: string | undefined | null;
      if (field === 'title') {
        updatedValue = await prompt.input({
          message: 'New title:',
          default: current.title,
          validate: (v: string) => (v.trim().length > 0 ? true : 'Title is required'),
        });
      } else if (field === 'description') {
        updatedValue = await prompt.editor({
          message: 'Description',
          default: current.description ?? '',
        });
      } else {
        updatedValue = await prompt.input({
          message: 'Link (blank to clear):',
          default: current.link ?? '',
        });
      }

      setPhase({ kind: 'running', step: 'saving' });
      const normalized = typeof updatedValue === 'string' ? updatedValue : '';
      const ticket = await updateTicket(ticketId, { [field]: normalized });
      setPhase({ kind: 'done', ticket, field });
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
      return <ResultCard kind="info" title="No tickets to edit" />;
    case 'no-draft-sprint':
      return (
        <ResultCard
          kind="warning"
          title="Current sprint is not a draft"
          lines={['Only draft sprints allow ticket edits.']}
        />
      );
    case 'error':
      return <ResultCard kind="error" title="Could not edit ticket" lines={[phase.message]} />;
    case 'done':
      return (
        <ResultCard
          kind="success"
          title={`Ticket ${phase.field} updated`}
          fields={[
            ['ID', phase.ticket.id],
            ['Title', phase.ticket.title],
            ['Project', phase.ticket.projectName],
          ]}
        />
      );
  }
}

function stepLabel(step: Extract<Phase, { kind: 'running' }>['step']): string {
  switch (step) {
    case 'select-ticket':
      return 'Awaiting ticket selection…';
    case 'select-field':
      return 'Awaiting field selection…';
    case 'edit':
      return 'Awaiting edit…';
    case 'saving':
      return 'Saving ticket…';
  }
}
