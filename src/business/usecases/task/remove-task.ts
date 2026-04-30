import type { Task } from '../../../domain/entities/task.ts';
import type { DomainError } from '../../../domain/errors/domain-error.ts';
import { NotFoundError } from '../../../domain/errors/not-found-error.ts';
import type { TaskRepository } from '../../../domain/repositories/task-repository.ts';
import { Result } from '../../../domain/result.ts';
import type { SprintId } from '../../../domain/values/sprint-id.ts';
import type { TaskId } from '../../../domain/values/task-id.ts';

/** Inputs to {@link RemoveTaskUseCase}. */
export interface RemoveTaskInput {
  readonly sprintId: SprintId;
  readonly taskId: TaskId;
}

/**
 * `RemoveTaskUseCase` — drop the matching task and persist the new list.
 * Returns the full updated list. Surfaces `NotFoundError` if the id is not
 * present in the sprint's task set.
 */
export class RemoveTaskUseCase {
  constructor(private readonly tasks: TaskRepository) {}

  async execute(input: RemoveTaskInput): Promise<Result<readonly Task[], DomainError>> {
    const existing = await this.tasks.findBySprintId(input.sprintId);
    if (!existing.ok) return Result.error(existing.error);

    if (!existing.value.some((t) => t.id === input.taskId)) {
      return Result.error(new NotFoundError({ entity: 'task', id: input.taskId }));
    }

    const next = existing.value.filter((t) => t.id !== input.taskId);
    const saved = await this.tasks.saveAll(input.sprintId, next);
    if (!saved.ok) return Result.error(saved.error);

    return Result.ok(next);
  }
}
