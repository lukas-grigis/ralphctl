import type { Task } from '@src/domain/entity/task.ts';
import type { SaveAllTasks } from '@src/domain/repository/task/save-all-tasks.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';
import { assertCtxField } from '@src/application/flows/_shared/_engine/assert-ctx-field.ts';

/** Minimum context shape the leaf reads. Both `sprintId` and `tasks` must be present. */
export interface SaveTasksCtx {
  readonly sprintId: SprintId;
  readonly tasks?: readonly Task[] | undefined;
}

export interface SaveTasksDeps {
  readonly taskRepo: SaveAllTasks;
}

/**
 * Reusable leaf that persists the full task set for a sprint atomically via `saveAll`. Generic
 * over `<TCtx extends SaveTasksCtx>` so any chain whose context carries `sprintId` + `tasks` can
 * reuse this leaf. Returns the ctx unchanged on success — saving is a side effect.
 *
 * If `ctx.tasks` is undefined, the leaf surfaces an `InvalidStateError` — this is a
 * chain-construction error (a save leaf was placed before any leaf that produces tasks).
 */
export const saveTasksLeaf = <TCtx extends SaveTasksCtx>(deps: SaveTasksDeps, name = 'save-tasks'): Element<TCtx> =>
  leaf<TCtx, { readonly sprintId: SprintId; readonly tasks: readonly Task[] }, void>(name, {
    useCase: {
      execute: async (input) => deps.taskRepo.saveAll(input.sprintId, input.tasks),
    },
    input: (ctx) => ({ sprintId: ctx.sprintId, tasks: assertCtxField(ctx, 'tasks', name) }),
    output: (ctx) => ctx,
  });
