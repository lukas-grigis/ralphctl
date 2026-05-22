import type { Element } from '@src/application/chain/element.ts';
import { sequential } from '@src/application/chain/build/sequential.ts';
import { loadAndAssertSprintSubChain } from '@src/application/flows/_shared/sprint/load-and-assert-sprint.ts';
import { transitionSprintToDoneLeaf } from '@src/application/flows/_shared/sprint/transition-to-done.ts';
import { appendJournalSeparatorLeaf } from '@src/application/flows/_shared/progress/append-journal-separator.ts';
import type { CloseSprintCtx } from '@src/application/flows/close-sprint/ctx.ts';
import type { CloseSprintDeps } from '@src/application/flows/close-sprint/deps.ts';

/**
 * Build the close-sprint chain — the explicit one-shot path for marking a sprint `done` after
 * implement + PR.
 *
 *   sequential('close-sprint', [
 *     load-and-assert-sprint(['review']),     // refuses any other status
 *     transition-sprint-to-done,              // review → done; persists internally
 *   ])
 *
 * Pairs with the review flow — the user picks whichever fits the moment:
 *  - `review` for iterative feedback rounds; transitions to `done` automatically when the
 *    user submits an empty round.
 *  - `close-sprint` for the "I'm done; close it" shortcut (no AI loop, no feedback).
 *
 * The `loadAndAssertSprintSubChain` whitelist rejects sprints not in `review`, so a stray
 * close on a `planned` / `active` sprint fails fast with `InvalidStateError`. Persistence
 * is internal to `transitionSprintToDoneUseCase`; no separate save leaf is needed downstream.
 *
 * `sprintId` enters via the runner's `initialCtx` (matching how `ticket-remove` is launched);
 * no opts bag is needed at the factory boundary.
 */
export const createCloseSprintFlow = (deps: CloseSprintDeps): Element<CloseSprintCtx> =>
  sequential<CloseSprintCtx>('close-sprint', [
    loadAndAssertSprintSubChain<CloseSprintCtx>({ sprintRepo: deps.sprintRepo }, ['review']),
    transitionSprintToDoneLeaf<CloseSprintCtx>({ sprintRepo: deps.sprintRepo, clock: deps.clock, logger: deps.logger }),
    appendJournalSeparatorLeaf<CloseSprintCtx>(
      { appendFile: deps.appendFile, clock: deps.clock, logger: deps.logger },
      { progressFile: deps.progressFile, status: 'closed', name: 'progress-journal-close' }
    ),
  ]);
