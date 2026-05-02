import type { Sprint } from '@src/domain/entities/sprint.ts';
import type { DomainError } from '@src/domain/errors/domain-error.ts';
import { NotFoundError } from '@src/domain/errors/not-found-error.ts';
import type { SprintRepository } from '@src/domain/repositories/sprint-repository.ts';
import { Result } from '@src/domain/result.ts';
import type { SprintId } from '@src/domain/values/sprint-id.ts';
import type { TicketId } from '@src/domain/values/ticket-id.ts';

/** Inputs to {@link RemoveTicketUseCase}. */
export interface RemoveTicketInput {
  readonly sprintId: SprintId;
  readonly ticketId: TicketId;
}

/**
 * `RemoveTicketUseCase` — remove a ticket from the sprint aggregate.
 * Surfaces `NotFoundError` if the sprint or ticket is unknown.
 */
export class RemoveTicketUseCase {
  constructor(private readonly sprints: SprintRepository) {}

  async execute(input: RemoveTicketInput): Promise<Result<Sprint, DomainError>> {
    const found = await this.sprints.findById(input.sprintId);
    if (!found.ok) return Result.error(found.error);

    if (found.value.ticketById(input.ticketId) === undefined) {
      return Result.error(new NotFoundError({ entity: 'ticket', id: input.ticketId }));
    }

    const updated = found.value.removeTicket(input.ticketId);
    if (!updated.ok) return Result.error(updated.error);

    const saved = await this.sprints.save(updated.value);
    if (!saved.ok) return Result.error(saved.error);

    return Result.ok(updated.value);
  }
}
