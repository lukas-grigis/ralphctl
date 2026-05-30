import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import {
  gitDeleteBranch,
  gitFoldBranch,
  gitWorktreeAdd,
  gitWorktreePrune,
  gitWorktreeRef,
  gitWorktreeRemove,
} from '@src/integration/io/git-operations.ts';
import type { GitRunner, GitRunOptions, GitRunResult } from '@src/integration/io/git-runner.ts';

const abs = (p: string): AbsolutePath => {
  const r = AbsolutePath.parse(p);
  if (!r.ok) throw new Error(`test setup: bad path ${p}`);
  return r.value;
};

const repoRoot = abs('/repo');
const worktreePath = abs('/repo/.ralphctl-worktrees/wt-task-1');

interface RecordedCall {
  readonly args: readonly string[];
  readonly opts: GitRunOptions | undefined;
}

interface ScriptedCall {
  readonly args: readonly string[];
  readonly result: Result<GitRunResult, StorageError>;
}

/**
 * Scripted fake runner: asserts the argv of each call in order, returns the canned result, and
 * records the `opts` so timeout overrides can be asserted.
 */
const scriptRunner = (calls: ScriptedCall[]): { runner: GitRunner; received: RecordedCall[] } => {
  const received: RecordedCall[] = [];
  let i = 0;
  const runner: GitRunner = {
    async run(_, args, opts) {
      received.push({ args, opts });
      const next = calls[i++];
      if (next === undefined) {
        throw new Error(`unscripted git call: ${args.join(' ')}`);
      }
      if (JSON.stringify(next.args) !== JSON.stringify(args)) {
        throw new Error(`expected git ${next.args.join(' ')} but got git ${args.join(' ')}`);
      }
      return next.result;
    },
  };
  return { runner, received };
};

const ok = (stdout = '', exitCode = 0, stderr = ''): Result<GitRunResult, StorageError> =>
  Result.ok({ stdout, stderr, exitCode });

describe('gitWorktreeRef', () => {
  it('builds the canonical ralphctl/<sprintId>/wt-<taskId> ref', () => {
    expect(gitWorktreeRef('sprint-abc', 'task-7')).toBe('ralphctl/sprint-abc/wt-task-7');
  });
});

describe('gitWorktreeAdd', () => {
  it('runs `worktree add -b <branch> <path>` with a bumped timeout', async () => {
    const branch = gitWorktreeRef('s1', 't1');
    const { runner, received } = scriptRunner([
      { args: ['worktree', 'add', '-b', branch, String(worktreePath)], result: ok() },
    ]);
    const result = await gitWorktreeAdd(runner, repoRoot, worktreePath, branch);
    expect(result.ok).toBe(true);
    expect(received[0]?.args).toEqual(['worktree', 'add', '-b', branch, String(worktreePath)]);
    // The add verb must raise the per-call timeout above the runner default.
    expect(received[0]?.opts?.timeoutMs).toBeGreaterThan(30_000);
  });

  it('surfaces a non-zero exit as StorageError', async () => {
    const branch = gitWorktreeRef('s1', 't1');
    const { runner } = scriptRunner([
      {
        args: ['worktree', 'add', '-b', branch, String(worktreePath)],
        result: ok('', 128, "fatal: a branch named 'ralphctl/s1/wt-t1' already exists"),
      },
    ]);
    const result = await gitWorktreeAdd(runner, repoRoot, worktreePath, branch);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('already exists');
  });

  it('propagates a runner transport error verbatim', async () => {
    const branch = gitWorktreeRef('s1', 't1');
    const { runner } = scriptRunner([
      {
        args: ['worktree', 'add', '-b', branch, String(worktreePath)],
        result: Result.error(new StorageError({ subCode: 'io', message: 'failed to spawn git: ENOENT' })),
      },
    ]);
    const result = await gitWorktreeAdd(runner, repoRoot, worktreePath, branch);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('failed to spawn git');
  });
});

describe('gitWorktreeRemove', () => {
  it('runs `worktree remove --force <path>`', async () => {
    const { runner, received } = scriptRunner([
      { args: ['worktree', 'remove', '--force', String(worktreePath)], result: ok() },
    ]);
    const result = await gitWorktreeRemove(runner, repoRoot, worktreePath);
    expect(result.ok).toBe(true);
    expect(received[0]?.args).toEqual(['worktree', 'remove', '--force', String(worktreePath)]);
  });

  it('surfaces a non-zero exit as StorageError', async () => {
    const { runner } = scriptRunner([
      {
        args: ['worktree', 'remove', '--force', String(worktreePath)],
        result: ok('', 1, 'fatal: validation failed'),
      },
    ]);
    const result = await gitWorktreeRemove(runner, repoRoot, worktreePath);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('validation failed');
  });
});

describe('gitDeleteBranch', () => {
  it('runs `branch -D <name>`', async () => {
    const branch = gitWorktreeRef('s1', 't1');
    const { runner, received } = scriptRunner([{ args: ['branch', '-D', branch], result: ok() }]);
    const result = await gitDeleteBranch(runner, repoRoot, branch);
    expect(result.ok).toBe(true);
    expect(received[0]?.args).toEqual(['branch', '-D', branch]);
  });

  it('surfaces a non-zero exit as StorageError', async () => {
    const branch = gitWorktreeRef('s1', 't1');
    const { runner } = scriptRunner([
      { args: ['branch', '-D', branch], result: ok('', 1, "error: branch '...' not found") },
    ]);
    const result = await gitDeleteBranch(runner, repoRoot, branch);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('not found');
  });
});

describe('gitWorktreePrune', () => {
  it('runs `worktree prune`', async () => {
    const { runner, received } = scriptRunner([{ args: ['worktree', 'prune'], result: ok() }]);
    const result = await gitWorktreePrune(runner, repoRoot);
    expect(result.ok).toBe(true);
    expect(received[0]?.args).toEqual(['worktree', 'prune']);
  });

  it('surfaces a non-zero exit as StorageError', async () => {
    const { runner } = scriptRunner([{ args: ['worktree', 'prune'], result: ok('', 1, 'boom') }]);
    const result = await gitWorktreePrune(runner, repoRoot);
    expect(result.ok).toBe(false);
  });
});

describe('gitFoldBranch', () => {
  const branch = gitWorktreeRef('s1', 't1');

  it('fast-forwards when the merge is ff-able (no cherry-pick path)', async () => {
    const { runner, received } = scriptRunner([{ args: ['merge', '--ff-only', branch], result: ok() }]);
    const result = await gitFoldBranch(runner, repoRoot, branch);
    expect(result.ok).toBe(true);
    // Only the ff merge runs — no merge-base / cherry-pick.
    expect(received.map((c) => c.args)).toEqual([['merge', '--ff-only', branch]]);
  });

  it('falls back to cherry-pick of <merge-base>..<branch> when ff fails', async () => {
    const mergeBase = 'a1b2c3d4e5f6a7b8c9d0';
    const { runner, received } = scriptRunner([
      { args: ['merge', '--ff-only', branch], result: ok('', 1, 'fatal: Not possible to fast-forward') },
      { args: ['merge-base', 'HEAD', branch], result: ok(`${mergeBase}\n`) },
      { args: ['cherry-pick', `${mergeBase}..${branch}`], result: ok() },
    ]);
    const result = await gitFoldBranch(runner, repoRoot, branch);
    expect(result.ok).toBe(true);
    expect(received.map((c) => c.args)).toEqual([
      ['merge', '--ff-only', branch],
      ['merge-base', 'HEAD', branch],
      ['cherry-pick', `${mergeBase}..${branch}`],
    ]);
  });

  it('surfaces a cherry-pick conflict as an error and aborts to leave the branch clean', async () => {
    const mergeBase = 'a1b2c3d4e5f6a7b8c9d0';
    const { runner, received } = scriptRunner([
      { args: ['merge', '--ff-only', branch], result: ok('', 1, 'not ff') },
      { args: ['merge-base', 'HEAD', branch], result: ok(`${mergeBase}\n`) },
      {
        args: ['cherry-pick', `${mergeBase}..${branch}`],
        result: ok('', 1, 'CONFLICT (content): Merge conflict in src/a.ts'),
      },
      { args: ['cherry-pick', '--abort'], result: ok() },
    ]);
    const result = await gitFoldBranch(runner, repoRoot, branch);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('cherry-pick failed');
      expect(result.error.message).toContain(branch);
    }
    // The conflict must trigger an abort so siblings stay landed.
    expect(received.map((c) => c.args)).toContainEqual(['cherry-pick', '--abort']);
  });

  it('rejects a non-SHA merge-base output', async () => {
    const { runner } = scriptRunner([
      { args: ['merge', '--ff-only', branch], result: ok('', 1, 'not ff') },
      { args: ['merge-base', 'HEAD', branch], result: ok('not-a-sha\n') },
    ]);
    const result = await gitFoldBranch(runner, repoRoot, branch);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('non-SHA');
  });

  it('surfaces a merge-base failure as StorageError', async () => {
    const { runner } = scriptRunner([
      { args: ['merge', '--ff-only', branch], result: ok('', 1, 'not ff') },
      { args: ['merge-base', 'HEAD', branch], result: ok('', 128, 'fatal: no merge base') },
    ]);
    const result = await gitFoldBranch(runner, repoRoot, branch);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('merge-base failed');
  });
});
