import type { Task } from '@src/domain/entities/task.ts';
import type { DomainError } from '@src/domain/errors/domain-error.ts';
import type { TaskRepository } from '@src/domain/repositories/task-repository.ts';
import type { Result } from '@src/domain/result.ts';
import type { SprintId } from '@src/domain/values/sprint-id.ts';

/** Inputs to {@link ListTasksUseCase}. */
export interface ListTasksInput {
  readonly sprintId: SprintId;
}

/**
 * `ListTasksUseCase` — return the sprint's task list. An empty array is a
 * normal state (sprint with no tasks yet) — not an error.
 */
export class ListTasksUseCase {
  constructor(private readonly tasks: TaskRepository) {}

  execute(input: ListTasksInput): Promise<Result<readonly Task[], DomainError>> {
    return this.tasks.findBySprintId(input.sprintId);
  }
}
