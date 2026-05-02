import { mkdir } from 'node:fs/promises';

import type { Task } from '@src/domain/entities/task.ts';
import { NotFoundError } from '@src/domain/errors/not-found-error.ts';
import { StorageError } from '@src/domain/errors/storage-error.ts';
import type { TaskRepository } from '@src/domain/repositories/task-repository.ts';
import { Result } from '@src/domain/result.ts';
import type { SprintId } from '@src/domain/values/sprint-id.ts';
import type { TaskId } from '@src/domain/values/task-id.ts';
import type { FileLocker } from './file-locker.ts';
import { readJsonFile, writeJsonFile } from './json-io.ts';
import { fromTask, taskListJsonSchema, toTask } from './schemas/task-schema.ts';
import { ensureLayoutDirsOnce, type StoragePaths } from './storage-paths.ts';

/**
 * `FileTaskRepository` — task list per sprint at
 * `<root>/data/sprints/<sprint-id>/tasks.json`.
 *
 * Concurrency: each sprint's file is locked independently so the per-task
 * `update` hot path is safe across parallel task settlements within the
 * same sprint. Different sprints don't contend.
 */
export class FileTaskRepository implements TaskRepository {
  constructor(
    private readonly paths: StoragePaths,
    private readonly locker: FileLocker
  ) {}

  async saveAll(sprintId: SprintId, tasks: readonly Task[]): Promise<Result<void, StorageError>> {
    const dir = this.paths.sprintDir(sprintId);
    const file = this.paths.tasksFile(sprintId);
    try {
      await ensureLayoutDirsOnce(this.paths);
      await mkdir(dir, { recursive: true });
    } catch (err) {
      return Result.error(
        new StorageError({
          subCode: 'io',
          message: `failed to create sprint dir ${dir}: ${stringifyError(err)}`,
          path: dir,
          cause: err,
        })
      );
    }
    const locked = await this.locker.withLock(file, () => writeJsonFile(file, tasks.map(fromTask), taskListJsonSchema));
    if (!locked.ok) return Result.error(locked.error);
    return locked.value;
  }

  async findBySprintId(sprintId: SprintId): Promise<Result<readonly Task[], StorageError>> {
    const file = this.paths.tasksFile(sprintId);
    const read = await readJsonFile(file, taskListJsonSchema);
    if (!read.ok) {
      if (isMissingFile(read.error)) {
        // No tasks file yet — that is a normal state for a fresh sprint.
        return Result.ok([]);
      }
      return Result.error(read.error);
    }
    const tasks: Task[] = [];
    for (const t of read.value) {
      const built = toTask(t);
      if (!built.ok) return Result.error(built.error);
      tasks.push(built.value);
    }
    return Result.ok(tasks);
  }

  async findById(sprintId: SprintId, taskId: TaskId): Promise<Result<Task, NotFoundError | StorageError>> {
    const all = await this.findBySprintId(sprintId);
    if (!all.ok) return Result.error(all.error);
    const found = all.value.find((t) => t.id === taskId);
    if (found === undefined) {
      return Result.error(
        new NotFoundError({
          entity: 'task',
          id: taskId,
          hint: 'Run `ralphctl task list --sprint <id>` to see available tasks.',
        })
      );
    }
    return Result.ok(found);
  }

  async update(sprintId: SprintId, task: Task): Promise<Result<void, NotFoundError | StorageError>> {
    const file = this.paths.tasksFile(sprintId);
    await ensureLayoutDirsOnce(this.paths);
    const locked = await this.locker.withLock(file, async () => {
      const read = await readJsonFile(file, taskListJsonSchema);
      if (!read.ok) {
        if (isMissingFile(read.error)) {
          return Result.error(new NotFoundError({ entity: 'task', id: task.id }));
        }
        return Result.error(read.error);
      }
      const idx = read.value.findIndex((t) => t.id === task.id);
      if (idx === -1) {
        return Result.error(new NotFoundError({ entity: 'task', id: task.id }));
      }
      const next = [...read.value];
      next[idx] = fromTask(task);
      return writeJsonFile(file, next, taskListJsonSchema);
    });
    if (!locked.ok) return Result.error(locked.error);
    return locked.value;
  }
}

function isMissingFile(err: StorageError): boolean {
  return err.subCode === 'io' && errnoCode(err.cause) === 'ENOENT';
}

function errnoCode(err: unknown): string | undefined {
  if (err instanceof Error && 'code' in err) {
    const c = (err as { code?: unknown }).code;
    if (typeof c === 'string') return c;
  }
  return undefined;
}

function stringifyError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
