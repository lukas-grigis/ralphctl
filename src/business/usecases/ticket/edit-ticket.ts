import type { Sprint } from '@src/domain/entities/sprint.ts';
import { Ticket } from '@src/domain/entities/ticket.ts';
import type { DomainError } from '@src/domain/errors/domain-error.ts';
import { NotFoundError } from '@src/domain/errors/not-found-error.ts';
import type { SprintRepository } from '@src/domain/repositories/sprint-repository.ts';
import { Result } from '@src/domain/result.ts';
import type { SprintId } from '@src/domain/values/sprint-id.ts';
import type { TicketId } from '@src/domain/values/ticket-id.ts';

/** Mutable subset of ticket fields exposed by edit. */
export interface EditTicketPartial {
  readonly title?: string;
  readonly description?: string;
  readonly link?: string;
}

/** Inputs to {@link EditTicketUseCase}. */
export interface EditTicketInput {
  readonly sprintId: SprintId;
  readonly ticketId: TicketId;
  readonly partial: EditTicketPartial;
}

/**
 * `EditTicketUseCase` — load the sprint, locate the ticket, reconstruct it
 * via {@link Ticket.create} with merged fields, then replace and persist.
 * Re-running the entity factory keeps validation centralised.
 *
 * Note: re-creating preserves only the fields exposed by `Ticket.create`'s
 * input. Lifecycle state (`requirementStatus`, `requirements`) is reset to
 * defaults by the factory; that's acceptable here because edit operates on
 * draft tickets only — the sprint's `replaceTicket` enforces draft status,
 * and an `approved` ticket shouldn't be edited via this path. (Approval has
 * a dedicated use case.)
 */
export class EditTicketUseCase {
  constructor(private readonly sprints: SprintRepository) {}

  async execute(input: EditTicketInput): Promise<Result<Sprint, DomainError>> {
    const found = await this.sprints.findById(input.sprintId);
    if (!found.ok) return Result.error(found.error);

    const current = found.value.ticketById(input.ticketId);
    if (current === undefined) {
      return Result.error(new NotFoundError({ entity: 'ticket', id: input.ticketId }));
    }

    const merged = Ticket.create({
      id: current.id,
      title: input.partial.title ?? current.title,
      description: 'description' in input.partial ? input.partial.description : current.description,
      link: 'link' in input.partial ? input.partial.link : current.link,
    });
    if (!merged.ok) return Result.error(merged.error);

    const replaced = found.value.replaceTicket(input.ticketId, merged.value);
    if (!replaced.ok) return Result.error(replaced.error);

    const saved = await this.sprints.save(replaced.value);
    if (!saved.ok) return Result.error(saved.error);

    return Result.ok(replaced.value);
  }
}
