import { Result } from '@src/domain/result.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import { addTicket, type DraftSprint, type Sprint } from '@src/domain/entity/sprint.ts';
import { type ApprovedTicket, approveTicketRequirements, type PendingTicket } from '@src/domain/entity/ticket.ts';
import type { ConflictError } from '@src/domain/value/error/conflict-error.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import type { ValidationError } from '@src/domain/value/error/validation-error.ts';

/**
 * Approve a pending ticket's requirements body and append it to a draft sprint. Used by the
 * ideate flow — the AI produced both the ticket text and its requirements in one round, so we
 * approve + add in a single business step. Pure: no I/O.
 *
 * Compare with {@link refineTicketUseCase} which uses `replaceTicket` because the ticket is
 * already on the sprint as `PendingTicket`. Here the ticket is freshly created and not yet on
 * the sprint, so we `addTicket` instead.
 */
export interface AddApprovedTicketProps {
  readonly sprint: Sprint;
  readonly ticket: PendingTicket;
  readonly requirementsBody: string;
  readonly logger: Logger;
}

export interface AddApprovedTicketOutput {
  readonly sprint: DraftSprint;
  readonly ticket: ApprovedTicket;
}

export const addApprovedTicketUseCase = (
  props: AddApprovedTicketProps
): Result<AddApprovedTicketOutput, ConflictError | InvalidStateError | ValidationError> => {
  const log = props.logger.named('ticket.add-approved');
  log.debug('approving + adding ticket', { ticketId: props.ticket.id, bodyLength: props.requirementsBody.length });

  if (props.requirementsBody.trim().length === 0) {
    log.warn('AI produced no requirements body', { ticketId: props.ticket.id });
    return Result.error(
      new InvalidStateError({
        entity: 'ticket',
        currentState: 'pending',
        attemptedAction: 'add-approved-ticket',
        message: `add-approved-ticket: empty requirements body for ticket '${String(props.ticket.id)}'`,
      })
    );
  }

  const approved = approveTicketRequirements(props.ticket, props.requirementsBody);
  if (!approved.ok) {
    log.warn('approveTicketRequirements failed', { ticketId: props.ticket.id, error: approved.error.message });
    return Result.error(approved.error);
  }

  const added = addTicket(props.sprint, approved.value);
  if (!added.ok) {
    log.warn('addTicket failed', { ticketId: props.ticket.id, error: added.error.message });
    return Result.error(added.error);
  }

  log.info(`added approved ticket '${approved.value.title}'`, {
    ticketId: approved.value.id,
    title: approved.value.title,
    bodyLength: props.requirementsBody.length,
  });
  return Result.ok({ sprint: added.value, ticket: approved.value });
};
