import { Result } from '@src/domain/result.ts';
import { removeTicket } from '@src/domain/entity/sprint.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';

import type {
  TicketRemoveCtx,
  TicketRemoveInput,
  TicketRemoveOutput,
} from '@src/application/flows/remove-ticket/ctx.ts';
import type { TicketRemoveDeps } from '@src/application/flows/remove-ticket/deps.ts';

/**
 * Drop a ticket from a sprint: the removeTicket guard (refuses non-draft sprints) applied to the
 * fresh sprint under the repository's locked `update`. The domain helper silently no-ops on unknown ticket
 * ids; this flow surfaces that as `removed: false` so the caller can decide whether to treat
 * it as an error (CLI exit 1) or a soft success (idempotent script).
 */
export const createTicketRemoveFlow = (deps: TicketRemoveDeps): Element<TicketRemoveCtx> =>
  leaf<TicketRemoveCtx, TicketRemoveInput, TicketRemoveOutput>('remove-ticket', {
    useCase: {
      async execute(input) {
        let before = 0;
        const saved = await deps.sprintRepo.update(input.sprintId, (fresh) => {
          before = fresh.tickets.length;
          return removeTicket(fresh, input.ticketId);
        });
        if (!saved.ok) return Result.error(saved.error);

        return Result.ok({
          removed: saved.value.tickets.length < before,
          remainingTickets: saved.value.tickets.length,
        });
      },
    },
    input: (c) => c.input,
    output: (c, o) => ({ ...c, output: o }),
    label: 'Remove ticket',
  });
