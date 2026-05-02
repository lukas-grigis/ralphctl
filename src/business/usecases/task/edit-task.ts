import type { Task } from '@src/domain/entities/task.ts';
import type { DomainError } from '@src/domain/errors/domain-error.ts';
import type { TaskRepository } from '@src/domain/repositories/task-repository.ts';
import { Result } from '@src/domain/result.ts';
import type { AbsolutePath } from '@src/domain/values/absolute-path.ts';
import type { SprintId } from '@src/domain/values/sprint-id.ts';
import type { TaskId } from '@src/domain/values/task-id.ts';

/** Inputs to {@link EditTaskUseCase}. */
export interface EditTaskInput {
  readonly sprintId: SprintId;
  readonly taskId: TaskId;
  readonly name?: string;
  /** `null` clears the description. `undefined` leaves it unchanged. */
  readonly description?: string | null;
  readonly steps?: readonly string[];
  readonly verificationCriteria?: readonly string[];
  readonly blockedBy?: readonly TaskId[];
  readonly projectPath?: AbsolutePath;
  /** `null` clears extraDimensions. `undefined` leaves it unchanged. */
  readonly extraDimensions?: readonly string[] | null;
}

/**
 * `EditTaskUseCase` — load a task, apply mutable-field edits via the
 * entity's own `update()` method, and persist via the repo's hot-path
 * `update()`. State guards (only `todo` tasks editable) live on the
 * entity; the use case is thin glue.
 */
export class EditTaskUseCase {
  constructor(private readonly tasks: TaskRepository) {}

  async execute(input: EditTaskInput): Promise<Result<Task, DomainError>> {
    const found = await this.tasks.findById(input.sprintId, input.taskId);
    if (!found.ok) return Result.error(found.error);

    const updated = found.value.update({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.steps !== undefined ? { steps: input.steps } : {}),
      ...(input.verificationCriteria !== undefined ? { verificationCriteria: input.verificationCriteria } : {}),
      ...(input.blockedBy !== undefined ? { blockedBy: input.blockedBy } : {}),
      ...(input.projectPath !== undefined ? { projectPath: input.projectPath } : {}),
      ...(input.extraDimensions !== undefined ? { extraDimensions: input.extraDimensions } : {}),
    });
    if (!updated.ok) return Result.error(updated.error);

    const saved = await this.tasks.update(input.sprintId, updated.value);
    if (!saved.ok) return Result.error(saved.error);

    return Result.ok(updated.value);
  }
}
