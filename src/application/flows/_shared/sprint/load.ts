import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { SprintRepository } from '@src/domain/repository/sprint/sprint-repository.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';

/** Minimum context shape the leaf reads (sprint id) and writes (loaded sprint). */
export interface LoadSprintCtx {
  readonly sprintId: SprintId;
  readonly sprint?: Sprint | undefined;
}

export interface LoadSprintDeps {
  readonly sprintRepo: SprintRepository;
}

/**
 * Reusable leaf that loads a `Sprint` from the repository and writes it onto `ctx.sprint`.
 * Generic over `<TCtx extends LoadSprintCtx>` so any chain whose context carries `sprintId` can
 * reuse this leaf without sub-typing. The `name` defaults to `'load-sprint'`; chains that load
 * the sprint multiple times (e.g. for transactional consistency mid-flow) pass a unique name.
 */
export const loadSprintLeaf = <TCtx extends LoadSprintCtx>(deps: LoadSprintDeps, name = 'load-sprint'): Element<TCtx> =>
  leaf<TCtx, { readonly id: SprintId }, Sprint>(name, {
    useCase: {
      execute: async (input) => deps.sprintRepo.findById(input.id),
    },
    input: (ctx) => ({ id: ctx.sprintId }),
    output: (ctx, sprint) => ({ ...ctx, sprint }),
  });
