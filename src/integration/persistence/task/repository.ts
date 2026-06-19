import { join } from 'node:path';
import { Result } from '@src/domain/result.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { Task } from '@src/domain/entity/task.ts';
import type { TaskRepository } from '@src/domain/repository/task/task-repository.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { NotFoundError } from '@src/domain/value/error/not-found-error.ts';
import type { StorageError } from '@src/domain/value/error/storage-error.ts';
import { fromJsonTasksFile, toJsonTasksFile } from '@src/integration/persistence/task/task.schema.ts';
import { readJson, writeJsonAtomic } from '@src/integration/io/fs.ts';
import { resolveSprintDir, sprintsDir } from '@src/integration/persistence/storage.ts';
import { decode } from '@src/integration/persistence/shared/decode.ts';
import type { FileLocker } from '@src/integration/io/file-locker.ts';

export interface FsTaskRepositoryDeps {
  /** Root of the on-disk layout. Each sprint's task set lives at `<root>/sprints/<id>--<slug>/tasks.json`. */
  readonly root: AbsolutePath;
  /**
   * Optional file lock used to serialise read-modify-write inside `update()`. The implement
   * chain takes a sprint-scoped lock at the launcher, which serialises within a sprint; this
   * extra per-file lock closes the cross-sprint / cross-project race where two chains touch
   * the same tasks.json (rare but possible). When undefined, `update()` runs unlocked —
   * acceptable for tests and CLI-shot callers that never overlap.
   */
  readonly fileLocker?: FileLocker;
}

/**
 * Filesystem-backed `TaskRepository`. The full task set for a sprint is one JSON array at
 * `<root>/sprints/<sprint-id>--<slug>/tasks.json`. `saveAll` rewrites the whole file atomically;
 * `update` reads + replaces + saves under the same atomic-write semantics.
 *
 * The task aggregate carries only a `sprintId` (no slug), so the tasks-file path goes through the
 * tolerant {@link resolveSprintDir} resolver. On a write where the sprint dir does not yet exist
 * (`saveAll` before any sprint save) the path falls back to the bare `<id>/` dir, which the next
 * sprint save reconciles onto the canonical name.
 *
 * `findById` walks the array in memory — task sets are bounded (a sprint's task list is
 * planned up front) so a linear scan is cheap. `findBySprintId` returns the array sorted by
 * the canonical `task.order` ascending.
 *
 * A missing tasks file is treated as "no tasks yet" — `findBySprintId` returns an empty list
 * and `findById` returns `NotFoundError`. The first `saveAll` materialises the file.
 */
export const createFsTaskRepository = (deps: FsTaskRepositoryDeps): TaskRepository => {
  /** Resolve the existing sprint dir, falling back to the bare `<id>/` path for first writes. */
  const dirFor = async (sprintId: SprintId): Promise<string> =>
    (await resolveSprintDir(deps.root, sprintId)) ?? join(sprintsDir(deps.root), String(sprintId));

  const tasksPathFor = async (sprintId: SprintId): Promise<string> => join(await dirFor(sprintId), 'tasks.json');

  const readAll = async (sprintId: SprintId): Promise<Result<readonly Task[], StorageError>> => {
    const path = await tasksPathFor(sprintId);
    const json = await readJson(path);
    if (!json.ok) {
      if (json.error instanceof NotFoundError)
        return Result.ok([] as readonly Task[]) as Result<readonly Task[], StorageError>;
      return Result.error(json.error);
    }
    return decode((input) => fromJsonTasksFile(input, path), json.value, { entity: 'task', path });
  };

  const writeAll = async (sprintId: SprintId, tasks: readonly Task[]): Promise<Result<void, StorageError>> =>
    writeJsonAtomic(await tasksPathFor(sprintId), toJsonTasksFile(tasks));

  return {
    async findById(sprintId, taskId) {
      const all = await readAll(sprintId);
      if (!all.ok) return Result.error(all.error);
      const match = all.value.find((t) => t.id === taskId);
      if (match === undefined) {
        return Result.error(
          new NotFoundError({
            entity: 'task',
            id: `${String(sprintId)}:${String(taskId)}`,
            message: `task '${String(taskId)}' not found in sprint '${String(sprintId)}'`,
          })
        );
      }
      return Result.ok(match);
    },

    async findBySprintId(sprintId) {
      const all = await readAll(sprintId);
      if (!all.ok) return Result.error(all.error);
      const ordered = [...all.value].sort((a, b) => a.order - b.order);
      return Result.ok(ordered);
    },

    async saveAll(sprintId, tasks) {
      const doWriteAll = async (): Promise<Result<void, StorageError>> => writeAll(sprintId, tasks);

      if (deps.fileLocker === undefined) return doWriteAll();
      const path = await tasksPathFor(sprintId);
      const lockPath = AbsolutePath.parse(`${path}.lock`);
      if (!lockPath.ok) return doWriteAll(); // path was valid for the tasks file; this can't fail.
      // Take the same per-file lock as `update()` so a wholesale rewrite (e.g. the cascade-unblock
      // read-modify-writeAll in `unblock-task`) can't interleave with a concurrent `update()` and
      // clobber its write. The lock path is built identically to `update()`.
      const locked = await deps.fileLocker.withLock(lockPath.value, doWriteAll);
      if (!locked.ok) return Result.error(locked.error);
      return locked.value;
    },

    async update(sprintId, task) {
      const doUpdate = async (): Promise<Result<void, NotFoundError | StorageError>> => {
        const all = await readAll(sprintId);
        if (!all.ok) return Result.error(all.error);
        const idx = all.value.findIndex((t) => t.id === task.id);
        if (idx === -1) {
          return Result.error(
            new NotFoundError({
              entity: 'task',
              id: `${String(sprintId)}:${String(task.id)}`,
              message: `task '${String(task.id)}' not found in sprint '${String(sprintId)}' — cannot update`,
            })
          );
        }
        const next = [...all.value];
        next[idx] = task;
        return writeAll(sprintId, next);
      };

      if (deps.fileLocker === undefined) return doUpdate();
      const path = await tasksPathFor(sprintId);
      const lockPath = AbsolutePath.parse(`${path}.lock`);
      if (!lockPath.ok) return doUpdate(); // path was valid for the tasks file; this can't fail.
      // The lock serialises read-modify-write so a concurrent writer can't slip in between our
      // `readAll` and `writeAll`. Note we hold the lock only for the update itself; reads
      // remain unlocked because they're safe on an atomically-written file.
      const locked = await deps.fileLocker.withLock(lockPath.value, doUpdate);
      if (!locked.ok) return Result.error(locked.error);
      return locked.value;
    },
  };
};
