import { Result } from '@src/domain/result.ts';
import type { Entity } from '@src/domain/entity/_base/entity.ts';
import type { HttpUrl } from '@src/domain/value/http-url.ts';
import { TicketId } from '@src/domain/value/id/ticket-id.ts';
import { parseHttpUrl } from '@src/domain/value/parsers/parse-http-url.ts';
import { parseOptionalString } from '@src/domain/value/parsers/parse-optional-string.ts';
import { parseRequiredString } from '@src/domain/value/parsers/parse-required-string.ts';
import { requireStatus } from '@src/domain/value/require-status.ts';
import { type InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import { type ValidationError } from '@src/domain/value/error/validation-error.ts';

interface TicketBase extends Entity<TicketId> {
  readonly title: string;
  readonly description?: string;
  readonly link?: HttpUrl;
  /**
   * External tracker reference — e.g. GitHub `#123`, GitLab `!456`, JIRA `PROJ-7`. Free-form
   * verbatim string; the harness propagates it onto generated tasks and surfaces it in commit
   * messages + PR / MR bodies. No format validation — different trackers, different shapes.
   */
  readonly externalRef?: string;
}

export interface PendingTicket extends TicketBase {
  readonly status: 'pending';
  readonly requirements: undefined;
}

export interface ApprovedTicket extends TicketBase {
  readonly status: 'approved';
  readonly requirements: string;
}

export type Ticket = PendingTicket | ApprovedTicket;

/**
 * Derived from `Ticket` — adding a new variant flows here automatically.
 * Lifecycle: starts `pending`, transitions once to `approved` after refinement.
 * @public
 */
export type TicketStatus = Ticket['status'];

export interface TicketCreateInput {
  readonly id?: TicketId;
  readonly title: string;
  readonly description?: string;
  readonly link?: string;
  readonly externalRef?: string;
}

export const createTicket = (input: TicketCreateInput): Result<PendingTicket, ValidationError> => {
  const title = parseRequiredString('ticket.title', input.title);
  if (!title.ok) return Result.error(title.error);

  const description = parseOptionalString('ticket.description', input.description);
  if (!description.ok) return Result.error(description.error);

  let link: HttpUrl | undefined;
  if (input.link !== undefined) {
    const parsed = parseHttpUrl('ticket.link', input.link);
    if (!parsed.ok) return Result.error(parsed.error);
    link = parsed.value;
  }

  return Result.ok({
    id: input.id ?? TicketId.generate(),
    title: title.value,
    ...(description.value !== undefined ? { description: description.value } : {}),
    ...(link !== undefined ? { link } : {}),
    ...(input.externalRef !== undefined ? { externalRef: input.externalRef } : {}),
    status: 'pending',
    requirements: undefined,
  });
};

/**
 * Set or clear the ticket's `link` field. Used by the refine flow's "create origin" path
 * after the issue is created on the remote tracker — we attach the new URL to the now-approved
 * ticket so subsequent refines / implement runs see it.
 */
export function setTicketLink(ticket: ApprovedTicket, url: string | undefined): Result<ApprovedTicket, ValidationError>;
export function setTicketLink(ticket: PendingTicket, url: string | undefined): Result<PendingTicket, ValidationError>;
export function setTicketLink(ticket: Ticket, url: string | undefined): Result<Ticket, ValidationError> {
  if (url === undefined) {
    const { link: _drop, ...rest } = ticket;
    void _drop;
    return Result.ok(rest as Ticket);
  }
  const parsed = parseHttpUrl('ticket.link', url);
  if (!parsed.ok) return Result.error(parsed.error);
  return Result.ok({ ...ticket, link: parsed.value });
}

export const approveTicketRequirements = (ticket: Ticket, text: string): Result<ApprovedTicket, InvalidStateError> => {
  const guard = requireStatus(
    'ticket',
    ticket,
    ['pending'] as const,
    'approve-requirements',
    'Requirements have already been approved for this ticket.'
  );
  if (!guard.ok) return Result.error(guard.error);
  return Result.ok({
    id: ticket.id,
    title: ticket.title,
    ...(ticket.description !== undefined ? { description: ticket.description } : {}),
    ...(ticket.link !== undefined ? { link: ticket.link } : {}),
    ...(ticket.externalRef !== undefined ? { externalRef: ticket.externalRef } : {}),
    status: 'approved',
    requirements: text,
  });
};
