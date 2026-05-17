import { Result } from '@src/domain/result.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import { addTicket, type DraftSprint, type Sprint } from '@src/domain/entity/sprint.ts';
import { createTicket, type PendingTicket, type TicketCreateInput } from '@src/domain/entity/ticket.ts';
import type { ConflictError } from '@src/domain/value/error/conflict-error.ts';
import type { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import type { ValidationError } from '@src/domain/value/error/validation-error.ts';

/**
 * Add one ticket to an in-memory `Sprint` aggregate. Pure: no I/O. The chain leaf wraps this
 * with persistence via the shared `saveSprintLeaf` after the interactive add-loop has collected
 * every ticket the user wants in this run.
 *
 * Wraps {@link createTicket} (validates title / link / description) plus {@link addTicket}
 * (enforces draft-only and ticket-id uniqueness on the sprint). Any of those can fail; the
 * union return type makes the failure modes explicit so callers can branch on them
 * (e.g. retry vs surface to user).
 */
export interface AddTicketProps {
  readonly sprint: Sprint;
  readonly ticket: TicketCreateInput;
  readonly logger: Logger;
}

export interface AddTicketOutput {
  readonly sprint: DraftSprint;
  readonly ticket: PendingTicket;
}

export const addTicketUseCase = (
  props: AddTicketProps
): Result<AddTicketOutput, ValidationError | ConflictError | InvalidStateError> => {
  const log = props.logger.named('ticket.add');
  log.debug('adding ticket to sprint', { sprintId: props.sprint.id, title: props.ticket.title });

  const created = createTicket(props.ticket);
  if (!created.ok) {
    log.warn('ticket validation failed', { sprintId: props.sprint.id, error: created.error.message });
    return Result.error(created.error);
  }

  const updated = addTicket(props.sprint, created.value);
  if (!updated.ok) {
    log.warn('cannot add ticket to sprint', {
      sprintId: props.sprint.id,
      ticketId: created.value.id,
      error: updated.error.message,
    });
    return Result.error(updated.error);
  }

  log.info(`added ticket '${created.value.title}'`, {
    sprintId: props.sprint.id,
    ticketId: created.value.id,
    title: created.value.title,
  });
  return Result.ok({ sprint: updated.value, ticket: created.value });
};
