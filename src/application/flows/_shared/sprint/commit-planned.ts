import { isDeepStrictEqual } from 'node:util';
import { Result } from '@src/domain/result.ts';
import { planSprint, type Sprint } from '@src/domain/entity/sprint.ts';
import type { Ticket } from '@src/domain/entity/ticket.ts';
import type { FindById } from '@src/domain/repository/_base/find-by-id.ts';
import type { UpdateSprint } from '@src/domain/repository/sprint/update-sprint.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import { ConflictError } from '@src/domain/value/error/conflict-error.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';
import { assertCtxField } from '@src/application/flows/_shared/_engine/assert-ctx-field.ts';

export interface CommitPlannedCtx {
  readonly sprintId: SprintId;
  readonly sprint?: Sprint;
}

/** What the session planned against — compared as persisted, so an absent optional equals `undefined`. */
export type TicketBasis<TCtx> = (ctx: TCtx) => readonly Ticket[];

interface CommitInput {
  readonly sprintId: SprintId;
  /** `undefined` when the reviewer rejected — nothing to commit. */
  readonly planned?: Sprint;
  readonly basis: readonly Ticket[];
}

const asPersisted = (tickets: readonly Ticket[]): unknown => JSON.parse(JSON.stringify(tickets));

const ticketsChanged = (sprintId: SprintId): ConflictError =>
  new ConflictError({
    entity: 'sprint',
    field: 'tickets',
    value: sprintId,
    message: `the sprint's tickets changed while this session was planning — nothing was saved`,
    hint: 'Re-run it so the plan covers the tickets as they are now.',
  });

const changedSince = (fresh: Sprint, basis: readonly Ticket[]): boolean =>
  !isDeepStrictEqual(asPersisted(fresh.tickets), asPersisted(basis));

const inputOf = <TCtx extends CommitPlannedCtx>(ctx: TCtx, basis: TicketBasis<TCtx>, name: string): CommitInput => {
  const sprint = assertCtxField(ctx, 'sprint', name);
  return {
    sprintId: ctx.sprintId,
    ...(sprint.status === 'planned' ? { planned: sprint } : {}),
    basis: basis(ctx),
  };
};

/**
 * Refuse BEFORE the task write when another writer changed the tickets during the planning session,
 * so a plan for a ticket set nobody planned never reaches `tasks.json`.
 */
export const assertTicketsUnchangedLeaf = <TCtx extends CommitPlannedCtx>(
  deps: { readonly sprintRepo: FindById<Sprint, SprintId> },
  basis: TicketBasis<TCtx>
): Element<TCtx> =>
  leaf<TCtx, CommitInput, void>('assert-tickets-unchanged', {
    useCase: {
      execute: async ({ sprintId, planned, basis: tickets }) => {
        if (planned === undefined) return Result.ok(undefined);
        const fresh = await deps.sprintRepo.findById(sprintId);
        if (!fresh.ok) return Result.error(fresh.error);
        return changedSince(fresh.value, tickets) ? Result.error(ticketsChanged(sprintId)) : Result.ok(undefined);
      },
    },
    input: (ctx) => inputOf(ctx, basis, 'assert-tickets-unchanged'),
    output: (ctx) => ctx,
    label: 'Check tickets',
    internal: true,
  });

/**
 * Persist the `draft → planned` transition as a locked read-modify-write: re-checks the ticket basis
 * under the lock and applies the planned tickets onto the fresh sprint, so a concurrent edit to any
 * other field survives. A rejected plan writes nothing.
 */
export const savePlannedSprintLeaf = <TCtx extends CommitPlannedCtx>(
  deps: { readonly sprintRepo: UpdateSprint; readonly clock: () => IsoTimestamp },
  basis: TicketBasis<TCtx>
): Element<TCtx> =>
  leaf<TCtx, CommitInput, Sprint | undefined>('save-sprint', {
    useCase: {
      execute: async ({ sprintId, planned, basis: tickets }) => {
        if (planned === undefined) return Result.ok(undefined);
        return deps.sprintRepo.update(sprintId, (fresh) => {
          if (changedSince(fresh, tickets)) return Result.error(ticketsChanged(sprintId));
          // planSprint refuses a sprint someone else already moved off `draft`.
          return planSprint({ ...fresh, tickets: planned.tickets }, deps.clock());
        });
      },
    },
    input: (ctx) => inputOf(ctx, basis, 'save-sprint'),
    output: (ctx, saved) => (saved === undefined ? ctx : { ...ctx, sprint: saved }),
    label: 'Save sprint',
    internal: true,
  });
