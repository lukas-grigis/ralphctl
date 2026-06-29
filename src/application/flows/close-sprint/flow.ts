import type { Element } from '@src/application/chain/element.ts';
import { sequential } from '@src/application/chain/build/sequential.ts';
import { loadAndAssertSprintSubChain } from '@src/application/flows/_shared/sprint/load-and-assert-sprint.ts';
import { transitionSprintToDoneLeaf } from '@src/application/flows/_shared/sprint/transition-to-done.ts';
import { appendJournalSeparatorLeaf } from '@src/application/flows/_shared/progress/append-journal-separator.ts';
import { createDistillStep } from '@src/application/flows/_shared/memory/distill-step.ts';
import { refreshMemoryMirrorLeaf } from '@src/application/flows/_shared/memory/refresh-memory-mirror.ts';
import type { CloseSprintCtx } from '@src/application/flows/close-sprint/ctx.ts';
import type { CloseSprintDeps } from '@src/application/flows/close-sprint/deps.ts';

/**
 * Build the close-sprint chain — the explicit one-shot path for marking a sprint `done` after
 * implement + PR.
 *
 *   sequential('close-sprint', [
 *     load-and-assert-sprint(['review']),     // refuses any other status
 *     refresh-memory-mirror,                  // always-on; durable narrative-tier (learnings.md) refresh
 *     distill-learnings-step,                 // opt-in; runs while sprint still `review`
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
 * `sprintId` enters via the runner's `initialCtx` (matching how `remove-ticket` is launched);
 * no opts bag is needed at the factory boundary.
 *
 * The memory-mirror refresh + distill step both run BEFORE the transition so the sprint is still
 * `review` while they work — a mid-distill abort leaves it un-closed and re-runnable. The mirror
 * refresh is ALWAYS-ON (it only reads the ledger + rewrites the derived `learnings.md`, independent
 * of the distill opt-in); the distill step is gated — when the operator declined the opt-in
 * (`distillRequested === false`) its inner `distill-gate` guard skips the body, and when
 * `deps.distill` / `deps.memoryMirror` are absent the respective step is omitted entirely.
 */
export const createCloseSprintFlow = (deps: CloseSprintDeps): Element<CloseSprintCtx> =>
  sequential<CloseSprintCtx>('close-sprint', [
    loadAndAssertSprintSubChain<CloseSprintCtx>({ sprintRepo: deps.sprintRepo }, ['review']),
    ...(deps.memoryMirror !== undefined
      ? [
          refreshMemoryMirrorLeaf<CloseSprintCtx>(
            { writeFile: deps.memoryMirror.writeFile, logger: deps.logger },
            { memoryRoot: deps.memoryMirror.memoryRoot, projectId: deps.memoryMirror.projectId }
          ),
        ]
      : []),
    ...(deps.distill !== undefined ? [createDistillStep<CloseSprintCtx>(deps.distill.deps, deps.distill.opts)] : []),
    transitionSprintToDoneLeaf<CloseSprintCtx>({ sprintRepo: deps.sprintRepo, clock: deps.clock, logger: deps.logger }),
    appendJournalSeparatorLeaf<CloseSprintCtx>(
      { appendFile: deps.appendFile, clock: deps.clock, logger: deps.logger },
      { progressFile: deps.progressFile, status: 'closed', name: 'progress-journal-close' }
    ),
  ]);
