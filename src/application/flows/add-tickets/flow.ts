import type { Element } from '@src/application/chain/element.ts';
import { sequential } from '@src/application/chain/build/sequential.ts';
import { saveSprintLeaf } from '@src/application/flows/_shared/sprint/save.ts';
import { loadAndAssertSprintSubChain } from '@src/application/flows/_shared/sprint/load-and-assert-sprint.ts';
import type { AddTicketsCtx } from '@src/application/flows/add-tickets/ctx.ts';
import type { AddTicketsDeps } from '@src/application/flows/add-tickets/deps.ts';
import { interactiveAddLoopLeaf } from '@src/application/flows/add-tickets/leaves/interactive-add-loop.ts';

/**
 * Build the add-tickets chain.
 *
 * Shape:
 *
 *   sequential('add-tickets', [
 *     load-and-assert-sprint(['draft']),
 *     interactive-add-loop,
 *     save-sprint,
 *   ])
 *
 * Cancel-mid-loop semantics: if the user adds N tickets and then aborts a prompt (Ctrl-C), the
 * `interactive-add-loop` leaf returns a failure and the surrounding `sequential` skips
 * `save-sprint`. The N already-added tickets remain only in the in-memory `ctx.sprint` and are
 * NOT persisted. Lean: the user re-runs `add-tickets` to add more — there is no
 * "atomic per-ticket save" until plan time, where the whole sprint becomes immutable. This
 * matches the v1 add-ticket UX: a clean cancel discards the run, an explicit "no more" finalises
 * the batch.
 *
 * For partial-progress recovery on hard crashes, callers can compose this chain with a
 * different per-iteration save strategy — but the default favours the simpler model. See the
 * P07 decision log for the rationale.
 */
export const createAddTicketsFlow = (deps: AddTicketsDeps): Element<AddTicketsCtx> =>
  sequential<AddTicketsCtx>('add-tickets', [
    loadAndAssertSprintSubChain<AddTicketsCtx>({ sprintRepo: deps.sprintRepo }, ['draft']),
    interactiveAddLoopLeaf({
      interactive: deps.interactive,
      logger: deps.logger,
      ...(deps.issueFetcher !== undefined ? { issueFetcher: deps.issueFetcher } : {}),
    }),
    saveSprintLeaf<AddTicketsCtx>({ sprintRepo: deps.sprintRepo }),
  ]);
