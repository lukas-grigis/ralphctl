import { Result } from '@src/domain/result.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { UpdateTask } from '@src/domain/repository/task/update-task.ts';
import type { InProgressTask } from '@src/domain/entity/task.ts';
import { recordRunningAttemptCommit } from '@src/domain/entity/task-attempts.ts';
import { type AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { CommitSha } from '@src/domain/value/commit-sha.ts';
import type { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import type { NotFoundError } from '@src/domain/value/error/not-found-error.ts';
import type { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { ValidationError } from '@src/domain/value/error/validation-error.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';

/**
 * Commit every change the gen-eval inner loop produced for the current task. Policy:
 *
 *   - Clean tree → `{ task, sha: undefined }` (no error — the AI may have only written
 *     .gitignored files or produced no diffs at all).
 *   - Dirty tree, commit succeeds → parse SHA, record on attempt, persist task, log info.
 *   - Dirty tree, commit fails (e.g. pre-commit hook rejects, message too long, hook crash)
 *     → FAIL the chain (`Result.error(StorageError)`). The previous "non-fatal warn" behaviour
 *     produced silent corruption: the task would settle as `done` while its changes remained
 *     uncommitted in the worktree, and the next sprint would see a dirty tree it didn't
 *     produce. Surfacing the error halts the chain, leaves the task `in_progress`, and lets
 *     the operator inspect the diff and either fix the hook or rerun the sprint.
 *
 * The `gitCommit` dep is a function-shape adapter: integration wires git operations behind it.
 */
export interface CommitResult {
  readonly committed: boolean;
  readonly headSha?: string | undefined;
}

export interface CommitTaskProps {
  readonly task: InProgressTask;
  readonly sprintId: SprintId;
  readonly message: string;
  readonly cwd: AbsolutePath;
  readonly gitCommit: (cwd: AbsolutePath, message: string) => Promise<Result<CommitResult, StorageError>>;
  readonly taskRepo: UpdateTask;
  readonly clock: () => IsoTimestamp;
  readonly logger: Logger;
}

export interface CommitTaskOutput {
  readonly task: InProgressTask;
  readonly sha?: string;
}

export const commitTaskUseCase = async (
  props: CommitTaskProps
): Promise<Result<CommitTaskOutput, InvalidStateError | NotFoundError | StorageError | ValidationError>> => {
  const log = props.logger.named('task.commit');
  log.debug('attempting commit', { taskId: props.task.id, cwd: props.cwd });

  const result = await props.gitCommit(props.cwd, props.message);
  if (!result.ok) {
    log.error('git commit failed — halting chain', { taskId: props.task.id, error: result.error.message });
    return Result.error(result.error);
  }
  if (!result.value.committed) {
    log.debug('clean tree, nothing to commit', { taskId: props.task.id });
    return Result.ok({ task: props.task });
  }

  const sha = result.value.headSha!;
  const parsedSha = CommitSha.parse(sha);
  if (!parsedSha.ok) {
    log.error('git returned invalid sha', { taskId: props.task.id, sha, error: parsedSha.error.message });
    return Result.error(parsedSha.error);
  }

  const recorded = recordRunningAttemptCommit(props.task, parsedSha.value);
  if (!recorded.ok) {
    log.error('cannot record commit on attempt', { taskId: props.task.id, error: recorded.error.message });
    return Result.error(recorded.error);
  }

  const persisted = await props.taskRepo.update(props.sprintId, recorded.value);
  if (!persisted.ok) {
    log.error('persist failed', { taskId: recorded.value.id, error: persisted.error.message });
    return Result.error(persisted.error);
  }

  log.info(`committed ${sha.slice(0, 8)}`, { taskId: props.task.id, sha });
  return Result.ok({ task: recorded.value, sha });
};
