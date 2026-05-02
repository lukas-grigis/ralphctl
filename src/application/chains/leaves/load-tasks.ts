/**
 * `loadTasksLeaf` — reusable Leaf factory that loads the full task list
 * for a sprint via {@link TaskRepository.findBySprintId} and writes it
 * onto the chain context.
 *
 * Used by both `plan` (replan needs the prior task set as AI context) and
 * `execute` (the executor enumerates tasks before fanning out).
 *
 * "No tasks" is a normal outcome — the leaf returns the empty array; it
 * does NOT surface a domain error.
 */
import type { Task } from '@src/domain/entities/task.ts';
import type { StorageError } from '@src/domain/errors/storage-error.ts';
import type { TaskRepository } from '@src/domain/repositories/task-repository.ts';
import type { Result } from '@src/domain/result.ts';
import type { SprintId } from '@src/domain/values/sprint-id.ts';
import { Leaf } from '@src/kernel/chain/leaf.ts';
import type { Element } from '@src/kernel/chain/element.ts';

export interface LoadTasksCtx {
  readonly sprintId: SprintId;
  readonly tasks?: readonly Task[];
}

export interface LoadTasksLeafDeps {
  readonly taskRepo: TaskRepository;
}

export function loadTasksLeaf<TCtx extends LoadTasksCtx>(deps: LoadTasksLeafDeps, name = 'load-tasks'): Element<TCtx> {
  return new Leaf<TCtx, { readonly sprintId: SprintId }, readonly Task[]>(name, {
    useCase: {
      async execute(input): Promise<Result<readonly Task[], StorageError>> {
        return deps.taskRepo.findBySprintId(input.sprintId);
      },
    },
    input: (ctx) => ({ sprintId: ctx.sprintId }),
    output: (ctx, tasks) => ({ ...ctx, tasks }),
  });
}
