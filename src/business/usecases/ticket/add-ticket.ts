import type { Sprint } from '@src/domain/entities/sprint.ts';
import { Ticket, type TicketCreateInput } from '@src/domain/entities/ticket.ts';
import type { DomainError } from '@src/domain/errors/domain-error.ts';
import type { SprintRepository } from '@src/domain/repositories/sprint-repository.ts';
import { Result } from '@src/domain/result.ts';
import type { SprintId } from '@src/domain/values/sprint-id.ts';

/** Inputs to {@link AddTicketUseCase}. */
export interface AddTicketInput {
  readonly sprintId: SprintId;
  readonly ticketInput: TicketCreateInput;
}

/**
 * `AddTicketUseCase` — construct a {@link Ticket} via the entity factory and
 * append it to the sprint aggregate. Lifecycle invariants (sprint must be
 * `draft`, no duplicate ticket id) are enforced by the entity.
 */
export class AddTicketUseCase {
  constructor(private readonly sprints: SprintRepository) {}

  async execute(input: AddTicketInput): Promise<Result<Sprint, DomainError>> {
    const found = await this.sprints.findById(input.sprintId);
    if (!found.ok) return Result.error(found.error);

    const ticket = Ticket.create(input.ticketInput);
    if (!ticket.ok) return Result.error(ticket.error);

    const updated = found.value.addTicket(ticket.value);
    if (!updated.ok) return Result.error(updated.error);

    const saved = await this.sprints.save(updated.value);
    if (!saved.ok) return Result.error(saved.error);

    return Result.ok(updated.value);
  }
}
