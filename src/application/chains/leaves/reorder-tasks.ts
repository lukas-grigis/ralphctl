/**
 * `reorderTasksLeaf` — wrap the kernel's pure
 * {@link topologicalReorder} algorithm as a Leaf so the chain trace shows
 * dependency-reordering as a distinct step.
 *
 * Reads `ctx.tasks` (set by `plan`/`ideate` after the AI emits the new
 * task set), reorders by `blockedBy`, and writes the reordered list
 * back. Stable: independent tasks keep their input ordering.
 *
 * Errors are converted from `topologicalReorder`'s plain payload into
 * `KernelError` instances so the trace surfaces them with a useful code
 * (`task-cycle` / `task-unknown-dep`).
 */
import { Result } from '@src/domain/result.ts';

import type { Task } from '@src/domain/entities/task.ts';
import { topologicalReorder } from '@src/kernel/algorithms/dependency-reorder.ts';
import type { Element, KernelError } from '@src/kernel/chain/element.ts';
import { Leaf } from '@src/kernel/chain/leaf.ts';

export interface ReorderTasksCtx {
  readonly tasks?: readonly Task[];
}

export function reorderTasksLeaf<TCtx extends ReorderTasksCtx>(name = 'reorder-tasks'): Element<TCtx> {
  return new Leaf<TCtx, { readonly tasks: readonly Task[] }, readonly Task[]>(name, {
    useCase: {
      async execute(input): Promise<Result<readonly Task[], KernelError>> {
        const reordered = topologicalReorder(
          input.tasks.map((t) => ({ item: t, id: t.id, blockedBy: [...t.blockedBy] }))
        );
        if (!reordered.ok) {
          if (reordered.error.code === 'cycle') {
            return Promise.resolve(
              Result.error<KernelError>({
                code: 'task-cycle',
                message: `dependency cycle: ${reordered.error.cycle.join(' → ')}`,
              })
            );
          }
          return Promise.resolve(
            Result.error<KernelError>({
              code: 'task-unknown-dep',
              message: `task '${reordered.error.from}' depends on unknown task '${reordered.error.to}'`,
            })
          );
        }
        return Promise.resolve(Result.ok(reordered.value));
      },
    },
    input: (ctx) => {
      if (!ctx.tasks) {
        throw new Error(`Leaf '${name}' requires ctx.tasks to be set`);
      }
      return { tasks: ctx.tasks };
    },
    output: (ctx, tasks) => ({ ...ctx, tasks }),
  });
}
