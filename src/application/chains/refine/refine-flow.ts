/**
 * `createRefineFlow` — build the chain definition for the refine workflow.
 *
 * Pure function: given the shared dependency graph + the workflow inputs,
 * returns a fresh `Element<RefineCtx>` ready to be launched via
 * `SessionManager.start({ element, initialCtx, label })`.
 *
 * Steps (happy path):
 *
 *   load-sprint → assert-draft → link-skills →
 *     refine-tickets (a Sequential of per-ticket sub-chains,
 *       each: refine-<id> → save-after-<id>)
 *     → unlink-skills
 *
 * Per-ticket save persists the approved ticket BEFORE moving to the next
 * ticket, so a crash mid-flight resumes correctly. This is the entire
 * reason the per-ticket loop is unrolled at chain-construction time
 * rather than handled inside a single leaf — the chain trace shows
 * exactly which tickets succeeded and which one broke the run.
 *
 * The factory takes the *pre-loaded* list of pending tickets in `opts`
 * so step count is fixed at construction time. The `load-sprint` leaf at
 * the head of the chain re-loads from disk for transactional consistency
 * — the in-flight chain works against the freshly-loaded sprint, not the
 * factory-time snapshot.
 */
import { Result } from 'typescript-result';

import type { Sprint } from '../../../domain/entities/sprint.ts';
import { InvalidStateError } from '../../../domain/errors/invalid-state-error.ts';
import type { Ticket } from '../../../domain/entities/ticket.ts';
import type { AbsolutePath } from '../../../domain/values/absolute-path.ts';
import type { SprintId } from '../../../domain/values/sprint-id.ts';
import type { TicketId } from '../../../domain/values/ticket-id.ts';
import type { Element } from '../../../kernel/chain/element.ts';
import { Leaf } from '../../../kernel/chain/leaf.ts';
import { Sequential } from '../../../kernel/chain/sequential.ts';
import { RefineSingleTicketUseCase } from '../../../business/usecases/refine/refine-single-ticket.ts';
import { linkSkillsLeaf } from '../leaves/link-skills.ts';
import { loadSprintLeaf } from '../leaves/load-sprint.ts';
import { saveSprintLeaf } from '../leaves/save-sprint.ts';
import { unlinkSkillsLeaf } from '../leaves/unlink-skills.ts';
import type { ChainSharedDeps } from '../chain-deps.ts';

/** Chain context for the refine flow. */
export interface RefineCtx {
  readonly sprintId: SprintId;
  readonly cwd: AbsolutePath;
  readonly sprint?: Sprint;
  readonly refinedTickets?: readonly Ticket[];
}

export interface CreateRefineFlowOpts {
  readonly sprintId: SprintId;
  readonly cwd: AbsolutePath;
  /**
   * Pending tickets to refine, in the order they should be processed.
   * Caller has already filtered to `requirementStatus === 'pending'`.
   * If empty, the chain still runs but the per-ticket Sequential is a
   * no-op.
   */
  readonly pendingTickets: readonly Ticket[];
}

export function createRefineFlow(
  deps: Pick<ChainSharedDeps, 'sprintRepo' | 'aiSession' | 'prompts' | 'logger' | 'skillsLinker'>,
  opts: CreateRefineFlowOpts
): Element<RefineCtx> {
  const refineUseCase = new RefineSingleTicketUseCase(deps.aiSession, deps.prompts, deps.logger);

  const perTicketChains: Element<RefineCtx>[] = opts.pendingTickets.map((ticket) =>
    buildPerTicketChain(deps, refineUseCase, ticket)
  );

  return new Sequential<RefineCtx>('refine', [
    loadSprintLeaf<RefineCtx>({ sprintRepo: deps.sprintRepo }),
    assertDraftLeaf<RefineCtx>(),
    linkSkillsLeaf<RefineCtx>({ skillsLinker: deps.skillsLinker }),
    new Sequential<RefineCtx>('refine-tickets', perTicketChains),
    unlinkSkillsLeaf<RefineCtx>({ skillsLinker: deps.skillsLinker }),
  ]);
}

function buildPerTicketChain(
  deps: Pick<ChainSharedDeps, 'sprintRepo' | 'aiSession' | 'prompts' | 'logger'>,
  refineUseCase: RefineSingleTicketUseCase,
  ticket: Ticket
): Element<RefineCtx> {
  const ticketShortId = ticket.id;
  return new Sequential<RefineCtx>(`refine-${ticketShortId}`, [
    refineTicketLeaf(refineUseCase, ticket.id),
    saveSprintLeaf<RefineCtx>({ sprintRepo: deps.sprintRepo }, `save-after-${ticketShortId}`),
  ]);
}

/**
 * Wrap `RefineSingleTicketUseCase` as a Leaf. Threads the loaded sprint
 * through to the use case (the use case operates on the entity, not the
 * id), then writes the approved ticket back via `Sprint.replaceTicket`
 * so the saveSprint leaf that follows persists the updated aggregate.
 */
function refineTicketLeaf(useCase: RefineSingleTicketUseCase, ticketId: TicketId): Element<RefineCtx> {
  return new Leaf<
    RefineCtx,
    {
      readonly sprint: Sprint;
      readonly ticket: Ticket;
      readonly cwd: AbsolutePath;
    },
    Sprint
  >(`refine-${ticketId}`, {
    useCase: {
      async execute(input) {
        const result = await useCase.execute({
          sprint: input.sprint,
          ticket: input.ticket,
          cwd: input.cwd,
        });
        if (!result.ok) return Result.error(result.error);
        const replaced = input.sprint.replaceTicket(input.ticket.id, result.value.ticket);
        if (!replaced.ok) return Result.error(replaced.error);
        return Result.ok(replaced.value);
      },
    },
    input: (ctx) => {
      if (!ctx.sprint) {
        throw new Error(`refine-${ticketId}: ctx.sprint must be loaded`);
      }
      const ticket = ctx.sprint.ticketById(ticketId);
      if (!ticket) {
        throw new Error(`refine-${ticketId}: ticket no longer present on sprint`);
      }
      return { sprint: ctx.sprint, ticket, cwd: ctx.cwd };
    },
    output: (ctx, sprint) => {
      const updated = sprint.ticketById(ticketId);
      const refined = updated !== undefined ? [...(ctx.refinedTickets ?? []), updated] : (ctx.refinedTickets ?? []);
      return { ...ctx, sprint, refinedTickets: refined };
    },
  });
}

/**
 * Inline guard leaf — fails the chain when the loaded sprint is not
 * `draft`. Surfaces an `InvalidStateError` so the trace clearly shows
 * the precondition that broke.
 */
function assertDraftLeaf<TCtx extends { readonly sprint?: Sprint }>(): Element<TCtx> {
  return new Leaf<TCtx, { readonly sprint: Sprint }, void>('assert-draft', {
    useCase: {
      async execute(input) {
        if (input.sprint.status !== 'draft') {
          return Promise.resolve(
            Result.error(
              new InvalidStateError({
                entity: 'sprint',
                currentState: input.sprint.status,
                attemptedAction: 'refine',
              })
            )
          );
        }
        return Promise.resolve(Result.ok(undefined));
      },
    },
    input: (ctx) => {
      if (!ctx.sprint) {
        throw new Error('assert-draft: ctx.sprint must be loaded first');
      }
      return { sprint: ctx.sprint };
    },
    output: (ctx) => ctx,
  });
}
