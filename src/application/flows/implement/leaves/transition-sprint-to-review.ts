import {
  type TransitionSprintToReviewProps,
  transitionSprintToReviewUseCase,
} from '@src/business/sprint/transition-sprint-to-review.ts';
import type { ReviewSprint, Sprint } from '@src/domain/entity/sprint.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';

/**
 * Chain leaf — adapts ctx → transitionSprintToReviewUseCase → ctx. Business policy
 * (active→review transition + persist + audit log) lives in
 * `@src/business/sprint/transition-sprint-to-review.ts`.
 */
export type TransitionSprintToReviewLeafDeps = Omit<TransitionSprintToReviewProps, 'sprint'>;

export const transitionSprintToReviewLeaf = (deps: TransitionSprintToReviewLeafDeps): Element<ImplementCtx> =>
  leaf<ImplementCtx, Sprint, ReviewSprint>('transition-sprint-to-review', {
    useCase: {
      execute: async (sprint) => transitionSprintToReviewUseCase({ ...deps, sprint }),
    },
    input: (ctx) => {
      if (ctx.sprint === undefined) {
        throw new InvalidStateError({
          entity: 'chain',
          currentState: 'pre-transition',
          attemptedAction: 'transition-sprint-to-review',
          message: 'transition-sprint-to-review: ctx.sprint is undefined — load-sprint must run first',
        });
      }
      return ctx.sprint;
    },
    output: (ctx, sprint) => ({ ...ctx, sprint }),
  });
