import type { SprintExecution } from '@src/domain/entity/sprint-execution.ts';
import type { SprintExecutionRepository } from '@src/domain/repository/sprint/sprint-execution-repository.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';
import { assertCtxField } from '@src/application/flows/_shared/_engine/assert-ctx-field.ts';

/** Minimum context shape the leaf reads. The execution must already be loaded. */
export interface SaveSprintExecutionCtx {
  readonly execution?: SprintExecution;
}

export interface SaveSprintExecutionDeps {
  readonly sprintExecutionRepo: SprintExecutionRepository;
}

/**
 * Reusable leaf that persists `ctx.execution`. Generic over
 * `<TCtx extends SaveSprintExecutionCtx>` so any chain whose context carries `execution` can
 * reuse this leaf. Returns the ctx unchanged on success — saving is a side effect.
 *
 * If `ctx.execution` is undefined, the leaf surfaces an `InvalidStateError` rather than silently
 * no-op'ing — this is a chain-construction error (a save leaf was placed before a load leaf).
 */
export const saveSprintExecutionLeaf = <TCtx extends SaveSprintExecutionCtx>(
  deps: SaveSprintExecutionDeps,
  name = 'save-sprint-execution'
): Element<TCtx> =>
  leaf<TCtx, SprintExecution, void>(name, {
    useCase: {
      execute: async (execution) => deps.sprintExecutionRepo.save(execution),
    },
    input: (ctx) => assertCtxField(ctx, 'execution', name),
    output: (ctx) => ctx,
  });
