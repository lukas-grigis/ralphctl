import { Result } from '@src/domain/result.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { runGitChecked, type GitRunner } from '@src/integration/io/git-runner.ts';
import { withWorktreeMutex } from '@src/integration/io/git-worktree-mutex.ts';

/**
 * Where a worktree ref holding commits the sprint branch lacks is moved instead of being deleted:
 * `ralphctl-rescue/<sprintId>/<taskId>-<yyyymmddThhmmssZ>`. Its own top-level namespace, so it can
 * never nest under (or contain) the sprint branch or a live worktree ref.
 */
export const gitRescueRef = (sprintId: string, taskId: string, at: string): string => {
  const stamp = new Date(at)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');
  return `ralphctl-rescue/${sprintId}/${taskId}-${stamp}`;
};

/**
 * How many commits on `ref` have no equivalent on `base` — `rev-list --right-only --cherry-pick`,
 * so a commit that already landed through a cherry-pick fold (new SHA, same patch) is not counted.
 */
export const gitUniqueCommitCount = async (
  runner: GitRunner,
  cwd: AbsolutePath,
  base: string,
  ref: string
): Promise<Result<number, StorageError>> => {
  const result = await runGitChecked(
    runner,
    cwd,
    ['rev-list', '--count', '--right-only', '--cherry-pick', `${base}...${ref}`],
    'rev-list --count'
  );
  if (!result.ok) return Result.error(result.error);
  const raw = result.value.stdout.trim();
  if (!/^\d+$/.test(raw)) {
    return Result.error(new StorageError({ subCode: 'io', message: `git rev-list --count returned '${raw}'` }));
  }
  return Result.ok(Number(raw));
};

/** Rename a local branch (`git branch -m`); refuses to overwrite an existing `to`. */
export const gitRenameBranch = async (
  runner: GitRunner,
  cwd: AbsolutePath,
  from: string,
  to: string
): Promise<Result<void, StorageError>> => {
  const result = await withWorktreeMutex(cwd, () =>
    runGitChecked(runner, cwd, ['branch', '-m', from, to], 'branch -m')
  );
  if (!result.ok) return Result.error(result.error);
  return Result.ok(undefined);
};
