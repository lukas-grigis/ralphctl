import { activateSprintUseCase, type ActivateSprintProps } from '@src/business/sprint/activate-sprint.ts';
import { type ActiveSprint, type Sprint } from '@src/domain/entity/sprint.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';

/**
 * Chain leaf — adapts ctx → activateSprintUseCase → ctx. The business policy (idempotent
 * planned→active transition + persist + audit log) lives in
 * `@src/business/sprint/activate-sprint.ts`.
 */
export type ActivateSprintLeafDeps = Omit<ActivateSprintProps, 'sprint'>;

export const activateSprintLeaf = (deps: ActivateSprintLeafDeps): Element<ImplementCtx> =>
  leaf<ImplementCtx, Sprint, ActiveSprint>('activate-sprint', {
    useCase: {
      execute: async (sprint) => activateSprintUseCase({ ...deps, sprint }),
    },
    input: (ctx) => {
      if (ctx.sprint === undefined) {
        throw new InvalidStateError({
          entity: 'chain',
          currentState: 'pre-activate',
          attemptedAction: 'activate-sprint',
          message: 'activate-sprint: ctx.sprint is undefined — load-sprint must run first',
        });
      }
      return ctx.sprint;
    },
    output: (ctx, sprint) => ({ ...ctx, sprint }),
  });
