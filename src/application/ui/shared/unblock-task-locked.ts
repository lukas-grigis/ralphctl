import { Result } from '@src/domain/result.ts';
import type { AppDeps } from '@src/application/bootstrap/wire.ts';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { PriorWorkDecision } from '@src/domain/entity/task-prior-work.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { TaskId } from '@src/domain/value/id/task-id.ts';
import type { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import type { NotFoundError } from '@src/domain/value/error/not-found-error.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import { unblockTaskUseCase, type UnblockTaskOutput } from '@src/business/task/unblock-task.ts';
import { repoLockFile } from '@src/integration/io/lock-paths.ts';
import { currentSprintDir } from '@src/integration/persistence/storage.ts';

export type UnblockTaskLockedDeps = Pick<
  AppDeps,
  'fileLocker' | 'storage' | 'taskRepo' | 'sprintRepo' | 'clock' | 'logger'
>;

export interface UnblockTaskLockedInput {
  readonly sprint: Pick<Sprint, 'id' | 'slug'>;
  readonly taskId: TaskId;
  readonly priorWork?: PriorWorkDecision;
}

/**
 * Manual unblock for every UI surface: holds the sprint-dir lock implement / review / close take for their
 * whole run, and re-reads the task under it, so a live run is waited out instead of clobbered.
 */
export const unblockTaskLocked = async (
  deps: UnblockTaskLockedDeps,
  input: UnblockTaskLockedInput
): Promise<Result<UnblockTaskOutput, InvalidStateError | NotFoundError | StorageError>> => {
  // Same dir the launchers lock: the legacy dir while a failed rename keeps the sprint there.
  const dir = AbsolutePath.parse(await currentSprintDir(deps.storage.dataRoot, input.sprint.id, input.sprint.slug));
  const lockPath = dir.ok ? repoLockFile(deps.storage.locksRoot, dir.value) : dir;
  if (!lockPath.ok) return Result.error(new StorageError({ subCode: 'lock', message: lockPath.error.message }));

  const locked = await deps.fileLocker.withLock(
    lockPath.value,
    async () => {
      const task = await deps.taskRepo.findById(input.sprint.id, input.taskId);
      if (!task.ok) return Result.error(task.error);
      return unblockTaskUseCase({
        task: task.value,
        sprintId: input.sprint.id,
        taskRepo: deps.taskRepo,
        sprintRepo: deps.sprintRepo,
        clock: deps.clock,
        logger: deps.logger,
        ...(input.priorWork !== undefined ? { priorWork: input.priorWork } : {}),
      });
    },
    { purpose: 'unblock' }
  );
  return locked.ok ? locked.value : Result.error(locked.error);
};
