import { describe, expect, it } from 'vitest';

import { AbsolutePath } from '../../domain/values/absolute-path.ts';
import { FakeGitRunner } from '../_test-fakes/fake-git-runner.ts';
import { GitOperations } from './git-operations.ts';

const cwd = AbsolutePath.trustString('/repo');

describe('GitOperations.hasUncommittedChanges', () => {
  it('returns true when porcelain output is non-empty', () => {
    const runner = new FakeGitRunner().on((a) => a[0] === 'status' && a[1] === '--porcelain', {
      stdout: ' M file.ts\n',
      exitCode: 0,
    });
    expect(new GitOperations(runner).hasUncommittedChanges(cwd)).toBe(true);
  });

  it('returns false when porcelain output is empty', () => {
    const runner = new FakeGitRunner().on((a) => a[0] === 'status', { stdout: '', exitCode: 0 });
    expect(new GitOperations(runner).hasUncommittedChanges(cwd)).toBe(false);
  });

  it('returns false when not in a git repo (non-zero exit)', () => {
    const runner = new FakeGitRunner().on((a) => a[0] === 'status', {
      stderr: 'fatal: not a git repository',
      exitCode: 128,
    });
    expect(new GitOperations(runner).hasUncommittedChanges(cwd)).toBe(false);
  });
});

describe('GitOperations.getCurrentBranch', () => {
  it('returns the trimmed branch name', () => {
    const runner = new FakeGitRunner().on((a) => a[0] === 'rev-parse' && a[1] === '--abbrev-ref', {
      stdout: 'main\n',
      exitCode: 0,
    });
    expect(new GitOperations(runner).getCurrentBranch(cwd)).toBe('main');
  });

  it('returns empty string for non-git repos', () => {
    const runner = new FakeGitRunner().on((a) => a[0] === 'rev-parse', { stderr: 'fatal', exitCode: 128 });
    expect(new GitOperations(runner).getCurrentBranch(cwd)).toBe('');
  });

  it('returns "HEAD" in detached state (git emits literal "HEAD")', () => {
    const runner = new FakeGitRunner().on((a) => a[0] === 'rev-parse', { stdout: 'HEAD\n', exitCode: 0 });
    expect(new GitOperations(runner).getCurrentBranch(cwd)).toBe('HEAD');
  });
});

describe('GitOperations.verifyBranch', () => {
  it('returns true when current matches expected', () => {
    const runner = new FakeGitRunner().on((a) => a[0] === 'rev-parse', { stdout: 'feature/x', exitCode: 0 });
    expect(new GitOperations(runner).verifyBranch(cwd, 'feature/x')).toBe(true);
  });

  it('returns false when current differs', () => {
    const runner = new FakeGitRunner().on((a) => a[0] === 'rev-parse', { stdout: 'main', exitCode: 0 });
    expect(new GitOperations(runner).verifyBranch(cwd, 'feature/x')).toBe(false);
  });

  it('returns false when not in a git repo', () => {
    const runner = new FakeGitRunner().on((a) => a[0] === 'rev-parse', { exitCode: 128 });
    expect(new GitOperations(runner).verifyBranch(cwd, 'main')).toBe(false);
  });
});

describe('GitOperations.getHeadSha', () => {
  it('returns the trimmed SHA', () => {
    const runner = new FakeGitRunner().on((a) => a[0] === 'rev-parse' && a[1] === 'HEAD', {
      stdout: 'abc123def456\n',
      exitCode: 0,
    });
    expect(new GitOperations(runner).getHeadSha(cwd)).toBe('abc123def456');
  });

  it('returns null on git failure', () => {
    const runner = new FakeGitRunner().on((a) => a[0] === 'rev-parse', { exitCode: 128 });
    expect(new GitOperations(runner).getHeadSha(cwd)).toBeNull();
  });

  it('returns null on empty stdout', () => {
    const runner = new FakeGitRunner().on((a) => a[0] === 'rev-parse', { stdout: '   \n', exitCode: 0 });
    expect(new GitOperations(runner).getHeadSha(cwd)).toBeNull();
  });
});

describe('GitOperations.getChangedFilesSince', () => {
  it('returns [] when baseline is not a hex SHA', () => {
    const runner = new FakeGitRunner();
    expect(new GitOperations(runner).getChangedFilesSince(cwd, 'not-a-sha')).toEqual([]);
    expect(runner.calls).toHaveLength(0);
  });

  it('combines committed diff + porcelain status', () => {
    const runner = new FakeGitRunner()
      .on((a) => a[0] === 'diff', { stdout: 'a.ts\nb.ts\n', exitCode: 0 })
      .on((a) => a[0] === 'status', { stdout: ' M b.ts\n?? c.ts\n', exitCode: 0 });
    const out = new GitOperations(runner).getChangedFilesSince(cwd, 'abc1234');
    expect([...out].sort()).toEqual(['a.ts', 'b.ts', 'c.ts']);
  });

  it('handles porcelain rename arrows', () => {
    const runner = new FakeGitRunner()
      .on((a) => a[0] === 'diff', { stdout: '', exitCode: 0 })
      .on((a) => a[0] === 'status', { stdout: 'R  old.ts -> new.ts\n', exitCode: 0 });
    const out = new GitOperations(runner).getChangedFilesSince(cwd, 'abc1234');
    expect(out).toEqual(['new.ts']);
  });

  it('returns [] when both git invocations fail', () => {
    const runner = new FakeGitRunner()
      .on((a) => a[0] === 'diff', { exitCode: 128 })
      .on((a) => a[0] === 'status', { exitCode: 128 });
    expect(new GitOperations(runner).getChangedFilesSince(cwd, 'abc1234')).toEqual([]);
  });
});

describe('GitOperations.getRecentGitHistory', () => {
  it('returns the trimmed log output', () => {
    const runner = new FakeGitRunner().on((a) => a[0] === 'log', { stdout: 'aaa add x\nbbb add y\n', exitCode: 0 });
    expect(new GitOperations(runner).getRecentGitHistory(cwd, 5)).toBe('aaa add x\nbbb add y');
  });

  it('returns a recognisable marker on git failure', () => {
    const runner = new FakeGitRunner().on((a) => a[0] === 'log', { exitCode: 128 });
    expect(new GitOperations(runner).getRecentGitHistory(cwd, 5)).toBe('(Unable to retrieve git history)');
  });

  it('rejects non-positive counts without spawning git', () => {
    const runner = new FakeGitRunner();
    expect(new GitOperations(runner).getRecentGitHistory(cwd, 0)).toBe('(Unable to retrieve git history)');
    expect(runner.calls).toHaveLength(0);
  });
});

describe('GitOperations.createAndCheckoutBranch', () => {
  it('rejects invalid branch names without invoking git', async () => {
    const runner = new FakeGitRunner();
    const r = await new GitOperations(runner).createAndCheckoutBranch(cwd, '-bad');
    expect(r.ok).toBe(false);
    expect(runner.calls).toHaveLength(0);
  });

  it('is a no-op when already on the requested branch', async () => {
    const runner = new FakeGitRunner().on((a) => a[0] === 'rev-parse', { stdout: 'feature/x', exitCode: 0 });
    const r = await new GitOperations(runner).createAndCheckoutBranch(cwd, 'feature/x');
    expect(r.ok).toBe(true);
    // Only the rev-parse to check current branch — no checkout.
    expect(runner.calls.map((c) => c.args[0])).toEqual(['rev-parse']);
  });

  it('checks out an existing branch', async () => {
    const runner = new FakeGitRunner()
      .on((a) => a[0] === 'rev-parse', { stdout: 'main', exitCode: 0 })
      .on((a) => a[0] === 'show-ref', { exitCode: 0 })
      .on((a) => a[0] === 'checkout', { exitCode: 0 });
    const r = await new GitOperations(runner).createAndCheckoutBranch(cwd, 'feature/x');
    expect(r.ok).toBe(true);
    const ops = runner.calls.map((c) => c.args[0]);
    expect(ops).toEqual(['rev-parse', 'show-ref', 'checkout']);
  });

  it('creates a new branch when show-ref fails', async () => {
    const runner = new FakeGitRunner()
      .on((a) => a[0] === 'rev-parse', { stdout: 'main', exitCode: 0 })
      .on((a) => a[0] === 'show-ref', { exitCode: 1 })
      .on((a) => a[0] === 'checkout' && a[1] === '-b', { exitCode: 0 });
    const r = await new GitOperations(runner).createAndCheckoutBranch(cwd, 'feature/x');
    expect(r.ok).toBe(true);
    expect(runner.calls.at(-1)?.args).toEqual(['checkout', '-b', 'feature/x']);
  });

  it('returns StorageError when checkout fails', async () => {
    const runner = new FakeGitRunner()
      .on((a) => a[0] === 'rev-parse', { stdout: 'main', exitCode: 0 })
      .on((a) => a[0] === 'show-ref', { exitCode: 0 })
      .on((a) => a[0] === 'checkout', { stderr: 'cannot switch', exitCode: 1 });
    const r = await new GitOperations(runner).createAndCheckoutBranch(cwd, 'feature/x');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.subCode).toBe('io');
      expect(r.error.message).toContain('feature/x');
    }
  });
});

describe('GitOperations.hardResetWorkingTree', () => {
  it('runs reset --hard then clean -fd', async () => {
    const runner = new FakeGitRunner()
      .on((a) => a[0] === 'reset', { exitCode: 0 })
      .on((a) => a[0] === 'clean', { exitCode: 0 });
    const r = await new GitOperations(runner).hardResetWorkingTree(cwd);
    expect(r.ok).toBe(true);
    expect(runner.calls.map((c) => c.args)).toEqual([
      ['reset', '--hard', 'HEAD'],
      ['clean', '-fd'],
    ]);
  });

  it('returns StorageError when reset fails (clean is skipped)', async () => {
    const runner = new FakeGitRunner().on((a) => a[0] === 'reset', { stderr: 'denied', exitCode: 1 });
    const r = await new GitOperations(runner).hardResetWorkingTree(cwd);
    expect(r.ok).toBe(false);
    expect(runner.calls).toHaveLength(1);
  });

  it('returns StorageError when clean fails', async () => {
    const runner = new FakeGitRunner()
      .on((a) => a[0] === 'reset', { exitCode: 0 })
      .on((a) => a[0] === 'clean', { stderr: 'permission denied', exitCode: 1 });
    const r = await new GitOperations(runner).hardResetWorkingTree(cwd);
    expect(r.ok).toBe(false);
  });
});

describe('GitOperations.autoCommit', () => {
  it('emits a "no-changes" StorageError on a clean tree without staging', async () => {
    const runner = new FakeGitRunner().on((a) => a[0] === 'status', { stdout: '', exitCode: 0 });
    const r = await new GitOperations(runner).autoCommit(cwd, 'msg');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      // Dedicated discriminator so callers don't have to match on
      // `message === 'no changes'` (legacy-parity shape, pre-cleanup).
      expect(r.error.subCode).toBe('no-changes');
      expect(r.error.message).toBe('no changes');
    }
    // Only the porcelain probe ran.
    expect(runner.calls.map((c) => c.args[0])).toEqual(['status']);
  });

  it('stages and commits when the tree is dirty', async () => {
    const runner = new FakeGitRunner()
      .on((a) => a[0] === 'status', { stdout: ' M f.ts\n', exitCode: 0 })
      .on((a) => a[0] === 'add', { exitCode: 0 })
      .on((a) => a[0] === 'commit', { exitCode: 0 });
    const r = await new GitOperations(runner).autoCommit(cwd, 'wip');
    expect(r.ok).toBe(true);
    const ops = runner.calls.map((c) => c.args);
    expect(ops).toEqual([
      ['status', '--porcelain'],
      ['add', '-A'],
      ['commit', '-m', 'wip'],
    ]);
  });

  it('returns StorageError when staging fails', async () => {
    const runner = new FakeGitRunner()
      .on((a) => a[0] === 'status', { stdout: ' M f.ts\n', exitCode: 0 })
      .on((a) => a[0] === 'add', { stderr: 'denied', exitCode: 1 });
    const r = await new GitOperations(runner).autoCommit(cwd, 'wip');
    expect(r.ok).toBe(false);
  });

  it('returns StorageError when commit fails (e.g. pre-commit hook reject)', async () => {
    const runner = new FakeGitRunner()
      .on((a) => a[0] === 'status', { stdout: ' M f.ts\n', exitCode: 0 })
      .on((a) => a[0] === 'add', { exitCode: 0 })
      .on((a) => a[0] === 'commit', { stderr: 'pre-commit hook failed', exitCode: 1 });
    const r = await new GitOperations(runner).autoCommit(cwd, 'wip');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.message).toContain('pre-commit');
    }
  });

  it('does not pass --no-verify (honours pre-commit hooks)', async () => {
    const runner = new FakeGitRunner()
      .on((a) => a[0] === 'status', { stdout: ' M f.ts\n', exitCode: 0 })
      .on((a) => a[0] === 'add', { exitCode: 0 })
      .on((a) => a[0] === 'commit', { exitCode: 0 });
    await new GitOperations(runner).autoCommit(cwd, 'wip');
    const commitCall = runner.calls.find((c) => c.args[0] === 'commit');
    expect(commitCall?.args).not.toContain('--no-verify');
  });
});

describe('GitOperations.stashChanges', () => {
  it('emits a "no-changes" StorageError on a clean tree without stashing', async () => {
    const runner = new FakeGitRunner().on((a) => a[0] === 'status', { stdout: '', exitCode: 0 });
    const r = await new GitOperations(runner).stashChanges(cwd, 'ralphctl test');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.subCode).toBe('no-changes');
    }
    expect(runner.calls.map((c) => c.args[0])).toEqual(['status']);
  });

  it('runs `git stash push -u -m <message>` when the tree is dirty', async () => {
    const runner = new FakeGitRunner()
      .on((a) => a[0] === 'status', { stdout: ' M f.ts\n', exitCode: 0 })
      .on((a) => a[0] === 'stash', { exitCode: 0 });
    const r = await new GitOperations(runner).stashChanges(cwd, 'ralphctl 20260429-x');
    expect(r.ok).toBe(true);
    const stashCall = runner.calls.find((c) => c.args[0] === 'stash');
    expect(stashCall?.args).toEqual(['stash', 'push', '-u', '-m', 'ralphctl 20260429-x']);
  });

  it('returns StorageError when the stash command fails', async () => {
    const runner = new FakeGitRunner()
      .on((a) => a[0] === 'status', { stdout: ' M f.ts\n', exitCode: 0 })
      .on((a) => a[0] === 'stash', { stderr: 'unmerged paths', exitCode: 1 });
    const r = await new GitOperations(runner).stashChanges(cwd, 'msg');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.message).toContain('unmerged paths');
    }
  });
});
