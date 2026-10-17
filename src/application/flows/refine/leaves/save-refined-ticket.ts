import { isDeepStrictEqual } from 'node:util';
import { Result } from '@src/domain/result.ts';
import { replaceTicket, type Sprint } from '@src/domain/entity/sprint.ts';
import type { ApprovedTicket, PendingTicket } from '@src/domain/entity/ticket.ts';
import type { UpdateSprint } from '@src/domain/repository/sprint/update-sprint.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import { ConflictError } from '@src/domain/value/error/conflict-error.ts';
import { NotFoundError } from '@src/domain/value/error/not-found-error.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';
import type { RefineCtx } from '@src/application/flows/refine/ctx.ts';

interface SaveRefinedInput {
  readonly sprintId: SprintId;
  /** `undefined` when the reviewer rejected — nothing to save. */
  readonly approved?: ApprovedTicket;
}

/** Compared as persisted, so an absent optional field equals an `undefined` one. */
const asPersisted = (ticket: unknown): unknown => JSON.parse(JSON.stringify(ticket));

/** Put the approved ticket onto the sprint as it is on disk now — other tickets' writes survive. */
const applyOnto = (fresh: Sprint, original: PendingTicket, approved: ApprovedTicket): Result<Sprint, DomainError> => {
  const current = fresh.tickets.find((t) => t.id === original.id);
  if (current === undefined) {
    return Result.error(
      new NotFoundError({
        entity: 'ticket',
        id: String(original.id),
        message: `ticket '${original.title}' was removed while it was being refined — nothing was saved for it`,
      })
    );
  }
  if (!isDeepStrictEqual(asPersisted(current), asPersisted(original))) {
    return Result.error(
      new ConflictError({
        entity: 'ticket',
        field: 'id',
        value: original.id,
        message: `ticket '${original.title}' changed while it was being refined — nothing was saved for it`,
        hint: 'Re-run refine so it works from the ticket as it is now.',
      })
    );
  }
  return replaceTicket(fresh, original.id, approved);
};

/** Persist one refined ticket through a locked read-modify-write instead of the sprint copy held since load. */
export const saveRefinedTicketLeaf = (
  deps: { readonly sprintRepo: UpdateSprint },
  ticket: PendingTicket
): Element<RefineCtx> =>
  leaf<RefineCtx, SaveRefinedInput, Sprint | undefined>(`save-after-${String(ticket.id)}`, {
    useCase: {
      execute: async ({ sprintId, approved }) => {
        if (approved === undefined) return Result.ok(undefined);
        return deps.sprintRepo.update(sprintId, (fresh) => applyOnto(fresh, ticket, approved));
      },
    },
    input: (ctx) => {
      const approved = ctx.refinedTickets?.find((t) => t.id === ticket.id);
      return { sprintId: ctx.sprintId, ...(approved !== undefined ? { approved } : {}) };
    },
    output: (ctx, saved) => (saved === undefined ? ctx : { ...ctx, sprint: saved }),
    label: 'Save sprint',
    internal: true,
  });
