/**
 * `useUnblockTask` — the runtime seam every view uses to revive a stuck task.
 * @public
 */

import { useCallback } from 'react';
import { useDeps } from '@src/application/ui/tui/runtime/deps-context.tsx';
import { unblockTaskUseCase, type UnblockTaskOutput } from '@src/business/task/unblock-task.ts';
import type { Result } from '@src/domain/result.ts';
import type { Task } from '@src/domain/entity/task.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import type { NotFoundError } from '@src/domain/value/error/not-found-error.ts';
import type { StorageError } from '@src/domain/value/error/storage-error.ts';

export type UnblockTaskResult = Result<UnblockTaskOutput, InvalidStateError | NotFoundError | StorageError>;

export type UnblockTask = (task: Task, sprintId: SprintId) => Promise<UnblockTaskResult>;

export const useUnblockTask = (): UnblockTask => {
  const deps = useDeps();
  return useCallback(
    (task: Task, sprintId: SprintId): Promise<UnblockTaskResult> =>
      unblockTaskUseCase({
        task,
        sprintId,
        taskRepo: deps.taskRepo,
        sprintRepo: deps.sprintRepo,
        clock: deps.clock,
        logger: deps.logger,
      }),
    [deps]
  );
};
