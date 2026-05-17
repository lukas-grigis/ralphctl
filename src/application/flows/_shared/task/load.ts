import { Result } from '@src/domain/result.ts';
import type { Task } from '@src/domain/entity/task.ts';
import type { FindTasksBySprintId } from '@src/domain/repository/task/find-tasks-by-sprint-id.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';

/** Minimum context shape the leaf reads (sprint id) and writes (loaded tasks). */
export interface LoadTasksCtx {
  readonly sprintId: SprintId;
  readonly tasks?: readonly Task[] | undefined;
}

export interface LoadTasksDeps {
  readonly taskRepo: FindTasksBySprintId;
}

/**
 * Reusable leaf that loads the full task set for a sprint and writes it onto `ctx.tasks`.
 * Generic over `<TCtx extends LoadTasksCtx>` so any chain whose context carries `sprintId` can
 * reuse this leaf without sub-typing. Reads the first page only — the task repository returns
 * the full task set per sprint without server-side pagination, so `items` is the complete list.
 */
export const loadTasksLeaf = <TCtx extends LoadTasksCtx>(deps: LoadTasksDeps, name = 'load-tasks'): Element<TCtx> =>
  leaf<TCtx, { readonly id: SprintId }, readonly Task[]>(name, {
    useCase: {
      execute: async (input) => {
        const page = await deps.taskRepo.findBySprintId(input.id);
        if (!page.ok) return Result.error(page.error);
        return Result.ok(page.value);
      },
    },
    input: (ctx) => ({ id: ctx.sprintId }),
    output: (ctx, tasks) => ({ ...ctx, tasks }),
  });
