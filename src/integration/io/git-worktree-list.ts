import { Result } from '@src/domain/result.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { GitRunner } from '@src/integration/io/git-runner.ts';

/** One registered worktree, as `git worktree list --porcelain` reports it. */
export interface GitWorktreeEntry {
  readonly path: string;
  /** Full ref (`refs/heads/<name>`); absent for a detached or bare worktree. */
  readonly branch?: string;
}

/** Every worktree registered with `repoRoot`'s repository, the main checkout first. */
export const gitWorktreeList = async (
  runner: GitRunner,
  repoRoot: AbsolutePath
): Promise<Result<readonly GitWorktreeEntry[], StorageError>> => {
  const result = await runner.run(repoRoot, ['worktree', 'list', '--porcelain']);
  if (!result.ok) return Result.error(result.error);
  if (result.value.exitCode !== 0) {
    return Result.error(
      new StorageError({
        subCode: 'io',
        message: `git worktree list failed: ${(result.value.stderr || result.value.stdout).trim()}`,
      })
    );
  }
  const entries: GitWorktreeEntry[] = [];
  for (const block of result.value.stdout.split(/\n\s*\n/)) {
    const lines = block.split('\n');
    const path = lines.find((l) => l.startsWith('worktree '))?.slice('worktree '.length);
    if (path === undefined || path.length === 0) continue;
    const branch = lines.find((l) => l.startsWith('branch '))?.slice('branch '.length);
    entries.push({ path, ...(branch !== undefined ? { branch } : {}) });
  }
  return Result.ok(entries);
};
