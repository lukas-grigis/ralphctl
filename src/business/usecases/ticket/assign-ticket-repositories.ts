import type { Sprint } from '../../../domain/entities/sprint.ts';
import type { DomainError } from '../../../domain/errors/domain-error.ts';
import { NotFoundError } from '../../../domain/errors/not-found-error.ts';
import type { SprintRepository } from '../../../domain/repositories/sprint-repository.ts';
import { Result } from '../../../domain/result.ts';
import type { AbsolutePath } from '../../../domain/values/absolute-path.ts';
import type { SprintId } from '../../../domain/values/sprint-id.ts';
import type { TicketId } from '../../../domain/values/ticket-id.ts';

/** Inputs to {@link AssignTicketRepositoriesUseCase}. */
export interface AssignTicketRepositoriesInput {
  readonly sprintId: SprintId;
  readonly ticketId: TicketId;
  readonly paths: readonly AbsolutePath[];
}

/**
 * `AssignTicketRepositoriesUseCase` — overwrite the affected-repositories
 * list on a ticket. Idempotent (mirrors `Ticket.assignRepositories`'s
 * semantics) — re-running with a different list wins.
 */
export class AssignTicketRepositoriesUseCase {
  constructor(private readonly sprints: SprintRepository) {}

  async execute(input: AssignTicketRepositoriesInput): Promise<Result<Sprint, DomainError>> {
    const found = await this.sprints.findById(input.sprintId);
    if (!found.ok) return Result.error(found.error);

    const current = found.value.ticketById(input.ticketId);
    if (current === undefined) {
      return Result.error(new NotFoundError({ entity: 'ticket', id: input.ticketId }));
    }

    const updated = current.assignRepositories(input.paths);
    const replaced = found.value.replaceTicket(input.ticketId, updated);
    if (!replaced.ok) return Result.error(replaced.error);

    const saved = await this.sprints.save(replaced.value);
    if (!saved.ok) return Result.error(saved.error);

    return Result.ok(replaced.value);
  }
}
