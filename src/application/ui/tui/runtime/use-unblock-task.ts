/**
 * `useUnblockTask` — the runtime seam every view uses to revive a stuck task, shaped like
 * {@link useLaunchCreateSprint}: the hook closes over `useDeps()` and assembles the use case's
 * six-field argument once, so a view supplies only the two things it actually knows (the task and
 * the sprint it belongs to).
 *
 * Manual unblock has no registered flow — it is a single repository write with no chain, no
 * prompts and no trace, so routing it through a flow factory would mean inventing a one-leaf
 * chain purely to satisfy the layering. A runtime hook is the sanctioned alternative for that
 * shape (DESIGN-SYSTEM §9): the view still never names a use case or reaches into `AppDeps`, and
 * the repository wiring lives in exactly one place instead of being re-derived per call site.
 *
 * The hook deliberately owns nothing else. Post-write concerns — mounted-ref guards, toast copy,
 * list refreshes — stay in the calling view, because each view sequences them differently.
 *
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
