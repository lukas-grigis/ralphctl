import { Result } from '@src/domain/result.ts';
import { removeTicket } from '@src/domain/entity/sprint.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';

import type {
  TicketRemoveCtx,
  TicketRemoveInput,
  TicketRemoveOutput,
} from '@src/application/flows/ticket-remove/ctx.ts';
import type { TicketRemoveDeps } from '@src/application/flows/ticket-remove/deps.ts';

/**
 * Drop a ticket from a sprint. Linear: load sprint → removeTicket guard (refuses non-draft
 * sprints) → save the updated sprint. The domain helper silently no-ops on unknown ticket
 * ids; this flow surfaces that as `removed: false` so the caller can decide whether to treat
 * it as an error (CLI exit 1) or a soft success (idempotent script).
 */
export const createTicketRemoveFlow = (deps: TicketRemoveDeps): Element<TicketRemoveCtx> =>
  leaf<TicketRemoveCtx, TicketRemoveInput, TicketRemoveOutput>('ticket-remove', {
    useCase: {
      async execute(input) {
        const sprint = await deps.sprintRepo.findById(input.sprintId);
        if (!sprint.ok) return Result.error(sprint.error);

        const before = sprint.value.tickets.length;
        const updated = removeTicket(sprint.value, input.ticketId);
        if (!updated.ok) return Result.error(updated.error);

        const saved = await deps.sprintRepo.save(updated.value);
        if (!saved.ok) return Result.error(saved.error);

        return Result.ok({
          removed: updated.value.tickets.length < before,
          remainingTickets: updated.value.tickets.length,
        });
      },
    },
    input: (c) => c.input,
    output: (c, o) => ({ ...c, output: o }),
  });
