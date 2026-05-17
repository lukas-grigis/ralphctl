import type { FindTaskById } from '@src/domain/repository/task/find-task-by-id.ts';
import type { FindTasksBySprintId } from '@src/domain/repository/task/find-tasks-by-sprint-id.ts';
import type { SaveAllTasks } from '@src/domain/repository/task/save-all-tasks.ts';
import type { UpdateTask } from '@src/domain/repository/task/update-task.ts';

/**
 * Tasks are scoped per sprint on disk — each sprint owns its full task set. Identity is
 * composite (sprintId + taskId), so this port does NOT extend the generic `FindById<E, I>` /
 * `Save<E>` / `Remove<I>` capabilities — those assume single-key identity. Instead it composes
 * its own child-aggregate capabilities (one file per capability under this folder); consumers
 * should depend on the narrow interface they actually need rather than the composite below.
 */
export interface TaskRepository extends SaveAllTasks, FindTasksBySprintId, FindTaskById, UpdateTask {}
