import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { SprintRepository } from '@src/domain/repository/sprint/sprint-repository.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';
import { assertCtxField } from '@src/application/flows/_shared/_engine/assert-ctx-field.ts';

/** Minimum context shape the leaf reads. The sprint must already be loaded. */
export interface SaveSprintCtx {
  readonly sprint?: Sprint;
}

export interface SaveSprintDeps {
  readonly sprintRepo: SprintRepository;
}

/**
 * Reusable leaf that persists `ctx.sprint`. Generic over `<TCtx extends SaveSprintCtx>` so any
 * chain whose context carries `sprint` can reuse this leaf. Returns the ctx unchanged on
 * success — saving is a side effect.
 *
 * If `ctx.sprint` is undefined, the leaf surfaces an `InvalidStateError` rather than silently
 * no-op'ing — this is a chain-construction error (a save leaf was placed before a load leaf).
 */
export const saveSprintLeaf = <TCtx extends SaveSprintCtx>(deps: SaveSprintDeps, name = 'save-sprint'): Element<TCtx> =>
  leaf<TCtx, Sprint, void>(name, {
    useCase: {
      execute: async (sprint) => deps.sprintRepo.save(sprint),
    },
    input: (ctx) => assertCtxField(ctx, 'sprint', name),
    output: (ctx) => ctx,
  });
