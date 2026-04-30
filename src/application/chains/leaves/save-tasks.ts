/**
 * `saveTasksLeaf` — reusable Leaf factory that atomically replaces the
 * full task list for a sprint via {@link TaskRepository.saveAll}.
 *
 * Used by `plan` (initial + replan) and `ideate` (combined ticket + tasks
 * write). The replace-all primitive is the only safe write for replan:
 * partial updates would leave the file mid-mutation visible to a crashing
 * harness.
 */
import type { Task } from '../../../domain/entities/task.ts';
import type { StorageError } from '../../../domain/errors/storage-error.ts';
import type { TaskRepository } from '../../../domain/repositories/task-repository.ts';
import type { Result } from '../../../domain/result.ts';
import type { SprintId } from '../../../domain/values/sprint-id.ts';
import { Leaf } from '../../../kernel/chain/leaf.ts';
import type { Element } from '../../../kernel/chain/element.ts';

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
