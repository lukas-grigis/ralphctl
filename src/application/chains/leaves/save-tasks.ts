/**
 * `saveTasksLeaf` — reusable Leaf factory that atomically replaces the
 * full task list for a sprint via {@link TaskRepository.saveAll}.
 *
 * Used by `plan` (initial + replan) and `ideate` (combined ticket + tasks
 * write). The replace-all primitive is the only safe write for replan:
 * partial updates would leave the file mid-mutation visible to a crashing
 * harness.
 */
import type { Task } from '@src/domain/entities/task.ts';
import type { StorageError } from '@src/domain/errors/storage-error.ts';
import type { TaskRepository } from '@src/domain/repositories/task-repository.ts';
import type { Result } from '@src/domain/result.ts';
import type { SprintId } from '@src/domain/values/sprint-id.ts';
import { Leaf } from '@src/kernel/chain/leaf.ts';
import type { Element } from '@src/kernel/chain/element.ts';

export interface SaveTasksCtx {
  readonly sprintId: SprintId;
  readonly tasks?: readonly Task[];
}

export interface SaveTasksLeafDeps {
  readonly taskRepo: TaskRepository;
}

export function saveTasksLeaf<TCtx extends SaveTasksCtx>(deps: SaveTasksLeafDeps, name = 'save-tasks'): Element<TCtx> {
  return new Leaf<TCtx, { readonly sprintId: SprintId; readonly tasks: readonly Task[] }, void>(name, {
    useCase: {
      async execute(input): Promise<Result<void, StorageError>> {
        return deps.taskRepo.saveAll(input.sprintId, input.tasks);
      },
    },
    input: (ctx) => {
      if (!ctx.tasks) {
        throw new Error(`Leaf '${name}' requires ctx.tasks to be set`);
      }
      return { sprintId: ctx.sprintId, tasks: ctx.tasks };
    },
    output: (ctx) => ctx,
  });
}
