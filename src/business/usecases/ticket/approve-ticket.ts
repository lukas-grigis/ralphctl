import type { Sprint } from '../../../domain/entities/sprint.ts';
import type { DomainError } from '../../../domain/errors/domain-error.ts';
import { NotFoundError } from '../../../domain/errors/not-found-error.ts';
import type { SprintRepository } from '../../../domain/repositories/sprint-repository.ts';
import { Result } from '../../../domain/result.ts';
import type { SprintId } from '../../../domain/values/sprint-id.ts';
import type { TicketId } from '../../../domain/values/ticket-id.ts';

/** Inputs to {@link ApproveTicketRequirementsUseCase}. */
export interface ApproveTicketRequirementsInput {
  readonly sprintId: SprintId;
  readonly ticketId: TicketId;
  readonly requirements: string;
}

/**
 * `ApproveTicketRequirementsUseCase` — flip the requirement lifecycle on a
 * ticket from `pending` to `approved`, capturing the refined text. Delegates
 * to {@link Ticket.approveRequirements} so re-approval is rejected by the
 * entity rather than by use-case-side guards.
 */
export class ApproveTicketRequirementsUseCase {
  constructor(private readonly sprints: SprintRepository) {}

  async execute(input: ApproveTicketRequirementsInput): Promise<Result<Sprint, DomainError>> {
    const found = await this.sprints.findById(input.sprintId);
    if (!found.ok) return Result.error(found.error);

    const current = found.value.ticketById(input.ticketId);
    if (current === undefined) {
      return Result.error(new NotFoundError({ entity: 'ticket', id: input.ticketId }));
    }

    const approved = current.approveRequirements(input.requirements);
    if (!approved.ok) return Result.error(approved.error);

    const replaced = found.value.replaceTicket(input.ticketId, approved.value);
    if (!replaced.ok) return Result.error(replaced.error);

    const saved = await this.sprints.save(replaced.value);
    if (!saved.ok) return Result.error(saved.error);

    return Result.ok(replaced.value);
  }
}
