import type { Task } from '@src/domain/entities/task.ts';
import type { DomainError } from '@src/domain/errors/domain-error.ts';
import type { TaskRepository } from '@src/domain/repositories/task-repository.ts';
import type { Result } from '@src/domain/result.ts';
import type { SprintId } from '@src/domain/values/sprint-id.ts';
import type { TaskId } from '@src/domain/values/task-id.ts';

/** Inputs to {@link ShowTaskUseCase}. */
export interface ShowTaskInput {
  readonly sprintId: SprintId;
  readonly taskId: TaskId;
}

/**
 * `ShowTaskUseCase` — fetch a single task scoped to its sprint. Surfaces
 * `NotFoundError` when the task id is absent from the sprint's task set.
 */
export class ShowTaskUseCase {
  constructor(private readonly tasks: TaskRepository) {}

  execute(input: ShowTaskInput): Promise<Result<Task, DomainError>> {
    return this.tasks.findById(input.sprintId, input.taskId);
  }
}
