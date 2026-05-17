import { Result } from '@src/domain/result.ts';
import type { Ticket } from '@src/domain/entity/ticket.ts';
import { createTicket } from '@src/domain/entity/ticket.ts';
import { addTicket } from '@src/domain/entity/sprint.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';

import type { TicketAddCtx, TicketAddInput } from '@src/application/flows/ticket-add/ctx.ts';
import type { TicketAddDeps } from '@src/application/flows/ticket-add/deps.ts';

/**
 * Append a pending ticket to a sprint. Linear: load sprint → mint ticket → addTicket guard
 * (refuses non-draft sprints, rejects duplicate ids) → save the updated sprint.
 */
export const createTicketAddFlow = (deps: TicketAddDeps): Element<TicketAddCtx> =>
  leaf<TicketAddCtx, TicketAddInput, Ticket>('ticket-add', {
    useCase: {
      async execute(input) {
        const sprint = await deps.sprintRepo.findById(input.sprintId);
        if (!sprint.ok) return Result.error(sprint.error);

        const ticketInput: Parameters<typeof createTicket>[0] = {
          title: input.title,
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.link !== undefined ? { link: input.link } : {}),
        };
        const ticket = createTicket(ticketInput);
        if (!ticket.ok) return Result.error(ticket.error);

        const updated = addTicket(sprint.value, ticket.value);
        if (!updated.ok) return Result.error(updated.error);

        const saved = await deps.sprintRepo.save(updated.value);
        if (!saved.ok) return Result.error(saved.error);

        return Result.ok(ticket.value);
      },
    },
    input: (c) => c.input,
    output: (c, o) => ({ ...c, output: o }),
  });
