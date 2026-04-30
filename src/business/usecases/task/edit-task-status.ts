import type { Task } from '../../../domain/entities/task.ts';
import type { DomainError } from '../../../domain/errors/domain-error.ts';
import type { TaskRepository } from '../../../domain/repositories/task-repository.ts';
import { Result } from '../../../domain/result.ts';
import type { SprintId } from '../../../domain/values/sprint-id.ts';
import type { TaskId } from '../../../domain/values/task-id.ts';

/**
 * Discriminated union of every status transition this use case knows how to
 * drive. `mark-blocked` carries a free-form reason so callers (e.g. the
 * branch-preflight fallback in the per-task chain) can record _why_ the task
 * couldn't proceed alongside the new state.
 */
export type EditTaskStatusAction =
  | { readonly kind: 'mark-in-progress' }
  | { readonly kind: 'mark-done' }
  | { readonly kind: 'mark-blocked'; readonly reason: string }
  | { readonly kind: 'unblock' };

/** Convenience alias for callers that only need the discriminator tag. */
export type EditTaskStatusActionKind = EditTaskStatusAction['kind'];

/** Inputs to {@link EditTaskStatusUseCase}. */
export interface EditTaskStatusInput {
  readonly sprintId: SprintId;
  readonly taskId: TaskId;
  readonly action: EditTaskStatusAction;
}

/**
 * `EditTaskStatusUseCase` — drive the task state machine through the entity's
 * own state-guarded methods. The use case dispatches by the action's `kind`
 * discriminator and propagates `InvalidStateError` faithfully.
 *
 * Supported transitions:
 *  - `mark-in-progress`: `todo → in_progress`
 *  - `mark-done`:        `in_progress → done`
 *  - `mark-blocked`:     `todo | in_progress → blocked` (carries `reason`)
 *  - `unblock`:          `blocked → todo`
 */
export class EditTaskStatusUseCase {
  constructor(private readonly tasks: TaskRepository) {}

  async execute(input: EditTaskStatusInput): Promise<Result<Task, DomainError>> {
    const found = await this.tasks.findById(input.sprintId, input.taskId);
    if (!found.ok) return Result.error(found.error);

    const transition = applyAction(found.value, input.action);
    if (!transition.ok) return Result.error(transition.error);

    const saved = await this.tasks.update(input.sprintId, transition.value);
    if (!saved.ok) return Result.error(saved.error);

    return Result.ok(transition.value);
  }
}

function applyAction(task: Task, action: EditTaskStatusAction): ReturnType<Task['markInProgress']> {
  switch (action.kind) {
    case 'mark-in-progress':
      return task.markInProgress();
    case 'mark-done':
      return task.markDone();
    case 'mark-blocked':
      return task.markBlocked(action.reason);
    case 'unblock':
      return task.unblock();
    default: {
      const _exhaustive: never = action;
      return _exhaustive;
    }
  }
}
