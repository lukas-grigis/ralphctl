import { Result } from '@src/domain/result.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import type { StorageError } from '@src/domain/value/error/storage-error.ts';

/**
 * Preflight check before each task: working tree must be clean. Policy is "cancel by default" —
 * uncommitted changes reject the task so the harness doesn't accidentally amend / commit them.
 * `dirtyTreePolicy='continue'` opts out (logs a warning and proceeds).
 *
 * The `gitStatusEntryCount` dep returns the number of porcelain entries — caller (chain leaf)
 * adapts the underlying git runner.
 */
export type DirtyTreePolicy = 'cancel' | 'continue';

export interface PreflightTaskProps {
  readonly cwd: AbsolutePath;
  readonly gitStatusEntryCount: (cwd: AbsolutePath) => Promise<Result<number, StorageError>>;
  readonly dirtyTreePolicy?: DirtyTreePolicy;
  readonly logger: Logger;
}

export type PreflightTaskOutput = void;

export const preflightTaskUseCase = async (
  props: PreflightTaskProps
): Promise<Result<PreflightTaskOutput, InvalidStateError | StorageError>> => {
  const log = props.logger.named('task.preflight');
  log.debug('checking working tree', { cwd: props.cwd });

  const count = await props.gitStatusEntryCount(props.cwd);
  if (!count.ok) {
    log.error('git status failed', { cwd: props.cwd, error: count.error.message });
    return Result.error(count.error);
  }
  if (count.value === 0) {
    log.debug('working tree clean', { cwd: props.cwd });
    return Result.ok(undefined);
  }

  const policy: DirtyTreePolicy = props.dirtyTreePolicy ?? 'cancel';
  if (policy === 'continue') {
    log.warn(`working tree dirty (${String(count.value)} entries) — proceeding (policy=continue)`, {
      cwd: props.cwd,
      dirtyEntries: count.value,
    });
    return Result.ok(undefined);
  }

  log.warn('refusing to start a task on a dirty tree', { cwd: props.cwd, dirtyEntries: count.value });
  return Result.error(
    new InvalidStateError({
      entity: 'working-tree',
      currentState: 'dirty',
      attemptedAction: 'preflight-task',
      message: `cannot start a task: ${String(count.value)} uncommitted change(s) in ${String(props.cwd)}`,
      hint: 'commit or stash your work, or pass --dirty=continue to override',
    })
  );
};
