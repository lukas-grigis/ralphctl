import type { Task } from '../entities/task.ts';
import type { NotFoundError } from '../errors/not-found-error.ts';
import type { StorageError } from '../errors/storage-error.ts';
import type { Result } from '../result.ts';
import type { SprintId } from '../values/sprint-id.ts';
import type { TaskId } from '../values/task-id.ts';

/**
 * `TaskRepository` — persistence port for the {@link Task} aggregate.
 *
 * Tasks are scoped per sprint on disk — each sprint owns a `tasks.json`
 * containing its full task set. The interface reflects the two access
 * patterns the runtime actually uses:
 *
 *  - **Planning / re-plan:** `saveAll(sprintId, tasks)` replaces the full
 *    set atomically. This is the only safe primitive for re-plan because
 *    it leaves no intermediate window where a partial set is visible.
 *  - **Execution hot path:** `update(sprintId, task)` modifies a single
 *    task. Implementations are expected to load → mutate → save under a
 *    file lock so concurrent task settlements don't corrupt the file.
 *
 * `findBySprintId` returns `[]` for a sprint that has no tasks yet —
 * "no tasks" is a normal state, not a missing-entity error.
 * `findById` / `update` surface {@link NotFoundError} when the requested
 * task id is absent from the sprint's task set.
 */
export interface TaskRepository {
  /** Atomically replace the full task set for a sprint. Used by planning / re-plan. */
  saveAll(sprintId: SprintId, tasks: readonly Task[]): Promise<Result<void, StorageError>>;
  /** Read the full task set for a sprint. Returns `[]` if the sprint has none. */
  findBySprintId(sprintId: SprintId): Promise<Result<readonly Task[], StorageError>>;
  /** Look up a single task within a sprint. */
  findById(sprintId: SprintId, taskId: TaskId): Promise<Result<Task, NotFoundError | StorageError>>;
  /**
   * Hot-path single-task update. Implementations load the current task
   * set, replace the matching id, and save under a file lock.
   */
  update(sprintId: SprintId, task: Task): Promise<Result<void, NotFoundError | StorageError>>;
}
