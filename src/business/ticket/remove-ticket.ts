import { Result } from '@src/domain/result.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import { removeTicket, type DraftSprint, type Sprint } from '@src/domain/entity/sprint.ts';
import type { TicketId } from '@src/domain/value/id/ticket-id.ts';
import type { Save } from '@src/domain/repository/_base/save.ts';
import type { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import type { StorageError } from '@src/domain/value/error/storage-error.ts';

/**
 * Drop a ticket from its draft sprint. Domain `removeTicket` rejects on non-draft sprints
 * (planned/active/review/done are immutable for ticket sets). Persists the trimmed sprint
 * on success.
 */
export interface RemoveTicketProps {
  readonly sprint: Sprint;
  readonly ticketId: TicketId;
  readonly sprintRepo: Save<Sprint>;
  readonly logger: Logger;
}

export const removeTicketUseCase = async (
  props: RemoveTicketProps
): Promise<Result<DraftSprint, InvalidStateError | StorageError>> => {
  const log = props.logger.named('ticket.remove');
  log.debug('removing ticket from sprint', { sprintId: props.sprint.id, ticketId: props.ticketId });

  const updated = removeTicket(props.sprint, props.ticketId);
  if (!updated.ok) {
    log.warn('removeTicket failed', {
      sprintId: props.sprint.id,
      ticketId: props.ticketId,
      error: updated.error.message,
    });
    return Result.error(updated.error);
  }

  const persisted = await props.sprintRepo.save(updated.value);
  if (!persisted.ok) {
    log.error('save failed', { sprintId: updated.value.id, error: persisted.error.message });
    return Result.error(persisted.error);
  }

  log.info('removed ticket from sprint', { sprintId: updated.value.id, ticketId: props.ticketId });
  return Result.ok(updated.value);
};
