import type { SprintExecution } from '@src/domain/entity/sprint-execution.ts';
import type { SprintExecutionRepository } from '@src/domain/repository/sprint/sprint-execution-repository.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';

/** Minimum context shape the leaf reads (sprint id) and writes (loaded execution). */
export interface LoadSprintExecutionCtx {
  readonly sprintId: SprintId;
  readonly execution?: SprintExecution | undefined;
}

export interface LoadSprintExecutionDeps {
  readonly sprintExecutionRepo: SprintExecutionRepository;
}

/**
 * Reusable leaf that loads a `SprintExecution` from the repository and writes it onto
 * `ctx.execution`. Sprint executions are paired 1:1 with sprints by `SprintId`. Generic over
 * `<TCtx extends LoadSprintExecutionCtx>` so any chain whose context carries `sprintId` can
 * reuse this leaf without sub-typing.
 */
export const loadSprintExecutionLeaf = <TCtx extends LoadSprintExecutionCtx>(
  deps: LoadSprintExecutionDeps,
  name = 'load-sprint-execution'
): Element<TCtx> =>
  leaf<TCtx, { readonly id: SprintId }, SprintExecution>(name, {
    useCase: {
      execute: async (input) => deps.sprintExecutionRepo.findById(input.id),
    },
    input: (ctx) => ({ id: ctx.sprintId }),
    output: (ctx, execution) => ({ ...ctx, execution }),
  });
