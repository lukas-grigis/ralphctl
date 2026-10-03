import { Result } from '@src/domain/result.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { FindTasksBySprintId } from '@src/domain/repository/task/find-tasks-by-sprint-id.ts';
import type { UpdateTask } from '@src/domain/repository/task/update-task.ts';
import type { Task } from '@src/domain/entity/task.ts';
import { failCurrentAttempt } from '@src/domain/entity/task-settle.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type { NotFoundError } from '@src/domain/value/error/not-found-error.ts';
import type { StorageError } from '@src/domain/value/error/storage-error.ts';

/** The operator stopped the run: quit, Runs `c`, or the run view's cancel picker. */
const OPERATOR_CANCEL = 'user-cancel';

export interface SettleAbandonedAttemptsDeps {
  readonly taskRepo: FindTasksBySprintId & UpdateTask;
  readonly clock: () => IsoTimestamp;
  readonly logger: Logger;
}

export interface SettleAbandonedAttemptsInput {
  readonly sprintId: SprintId;
  /** Epoch ms the stopped run began; only attempts it opened are its to settle. */
  readonly since: number;
}

/** Attempts older than the stopped run belong to an earlier, interrupted process and keep their own recovery. */
export interface SettleAbandonedAttempts {
  execute(input: SettleAbandonedAttemptsInput): Promise<Result<readonly string[], StorageError | NotFoundError>>;
}

const openedSince = (task: Task, since: number): boolean => {
  const last = task.attempts.at(-1);
  return last?.status === 'running' && Date.parse(last.startedAt) >= since;
};

export const createSettleAbandonedAttempts = (deps: SettleAbandonedAttemptsDeps): SettleAbandonedAttempts => ({
  async execute(input) {
    const log = deps.logger.named('task.settle-abandoned');
    const listed = await deps.taskRepo.findBySprintId(input.sprintId);
    if (!listed.ok) return Result.error(listed.error);
    const settled: string[] = [];
    for (const task of listed.value.filter((t) => openedSince(t, input.since))) {
      const aborted = failCurrentAttempt(task, deps.clock(), 'aborted', { abortCause: OPERATOR_CANCEL });
      if (!aborted.ok) continue;
      const saved = await deps.taskRepo.update(input.sprintId, aborted.value);
      if (!saved.ok) return Result.error(saved.error);
      settled.push(task.id);
    }
    if (settled.length > 0) log.info('settled attempts of a stopped run as operator-cancelled', { tasks: settled });
    return Result.ok(settled) as Result<readonly string[], StorageError | NotFoundError>;
  },
});
