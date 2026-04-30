import { Task, type TaskCreateInput } from '../../../domain/entities/task.ts';
import type { DomainError } from '../../../domain/errors/domain-error.ts';
import { ConflictError } from '../../../domain/errors/conflict-error.ts';
import type { TaskRepository } from '../../../domain/repositories/task-repository.ts';
import { Result } from '../../../domain/result.ts';
import type { SprintId } from '../../../domain/values/sprint-id.ts';

/**
 * Inputs to {@link AddTaskUseCase}.
 *
 * `taskInput.order` is optional — when omitted, the use case auto-assigns
 * the next-largest order in the existing task set (current max + 1, or 1
 * for an empty sprint).
 */
export interface AddTaskInput {
  readonly sprintId: SprintId;
  readonly taskInput: Omit<TaskCreateInput, 'order'> & { readonly order?: number };
}

/**
 * `AddTaskUseCase` — append a task to the sprint's task list. Returns the
 * full updated list (callers usually want the post-state to render).
 *
 * Auto-assigns `order` when missing — a small convenience that keeps
 * call-sites from re-deriving "what's next" boilerplate.
 */
export class AddTaskUseCase {
  constructor(private readonly tasks: TaskRepository) {}

  async execute(input: AddTaskInput): Promise<Result<readonly Task[], DomainError>> {
    const existing = await this.tasks.findBySprintId(input.sprintId);
    if (!existing.ok) return Result.error(existing.error);

    const order = input.taskInput.order ?? nextOrder(existing.value);

    const taskResult = Task.create({ ...input.taskInput, order });
    if (!taskResult.ok) return Result.error(taskResult.error);

    if (existing.value.some((t) => t.id === taskResult.value.id)) {
      return Result.error(new ConflictError({ entity: 'task', conflictingId: taskResult.value.id }));
    }

    const next = [...existing.value, taskResult.value];
    const saved = await this.tasks.saveAll(input.sprintId, next);
    if (!saved.ok) return Result.error(saved.error);

    return Result.ok(next);
  }
}

function nextOrder(tasks: readonly Task[]): number {
  if (tasks.length === 0) return 1;
  let max = 0;
  for (const t of tasks) {
    if (t.order > max) max = t.order;
  }
  return max + 1;
}
