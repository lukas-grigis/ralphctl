import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { type StorageError } from '@src/domain/value/error/storage-error.ts';
import {
  gitAddAll,
  gitBranchExists,
  gitCommitWithMessage,
  gitCreateAndCheckoutBranch,
  gitGetCurrentBranch,
  gitHasUncommittedChanges,
  gitResetHard,
  gitRevParseHead,
  gitStashPush,
  gitStatusPorcelain,
} from '@src/integration/io/git-operations.ts';
import type { GitRunner, GitRunResult } from '@src/integration/io/git-runner.ts';

const cwd = ((): AbsolutePath => {
  const r = AbsolutePath.parse('/tmp');
  if (!r.ok) throw new Error('test setup');
  return r.value;
})();

interface ScriptedCall {
  readonly args: readonly string[];
  readonly result: Result<GitRunResult, StorageError>;
}

const scriptRunner = (calls: ScriptedCall[]): { runner: GitRunner; received: Array<{ args: readonly string[] }> } => {
  const received: Array<{ args: readonly string[] }> = [];
  let i = 0;
  const runner: GitRunner = {
    async run(_, args) {
      received.push({ args });
      const next = calls[i++];
      if (next === undefined) {
        throw new Error(`unscripted git call: ${args.join(' ')}`);
      }
      // Match the args at runtime — fail loud if the caller's order changed.
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

describe('gitStatusPorcelain', () => {
  it('returns empty list on clean tree', async () => {
    const { runner } = scriptRunner([{ args: ['status', '--porcelain'], result: ok('') }]);
    const result = await gitStatusPorcelain(runner, cwd);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual([]);
  });

  it('parses entries including renames', async () => {
    const stdout = ' M src/a.ts\nA  src/b.ts\nR  src/old.ts -> src/new.ts\n?? untracked.txt\n';
    const { runner } = scriptRunner([{ args: ['status', '--porcelain'], result: ok(stdout) }]);
    const result = await gitStatusPorcelain(runner, cwd);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual([
        { status: ' M', path: 'src/a.ts' },
        { status: 'A ', path: 'src/b.ts' },
        { status: 'R ', path: 'src/new.ts' },
        { status: '??', path: 'untracked.txt' },
      ]);
    }
  });

  it('surfaces non-zero exit as StorageError', async () => {
    const { runner } = scriptRunner([
      { args: ['status', '--porcelain'], result: ok('', 128, 'fatal: not a git repo') },
    ]);
    const result = await gitStatusPorcelain(runner, cwd);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('fatal');
  });
});

describe('gitHasUncommittedChanges', () => {
  it('false on clean tree', async () => {
    const { runner } = scriptRunner([{ args: ['status', '--porcelain'], result: ok('') }]);
    const result = await gitHasUncommittedChanges(runner, cwd);
    expect(result.ok && result.value).toBe(false);
  });

  it('true when status has any entry', async () => {
    const { runner } = scriptRunner([{ args: ['status', '--porcelain'], result: ok(' M file\n') }]);
    const result = await gitHasUncommittedChanges(runner, cwd);
    expect(result.ok && result.value).toBe(true);
  });
});

describe('gitRevParseHead', () => {
  it('returns trimmed SHA on success', async () => {
    const sha = 'a'.repeat(40);
    const { runner } = scriptRunner([{ args: ['rev-parse', 'HEAD'], result: ok(`${sha}\n`) }]);
    const result = await gitRevParseHead(runner, cwd);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(sha);
  });

  it('rejects non-SHA output', async () => {
    const { runner } = scriptRunner([{ args: ['rev-parse', 'HEAD'], result: ok('not-a-sha\n') }]);
    const result = await gitRevParseHead(runner, cwd);
    expect(result.ok).toBe(false);
  });
});

describe('gitAddAll', () => {
  it('runs git add -A and returns ok on success', async () => {
    const { runner } = scriptRunner([{ args: ['add', '-A'], result: ok() }]);
    const result = await gitAddAll(runner, cwd);
    expect(result.ok).toBe(true);
  });
});

describe('gitCommitWithMessage', () => {
  const sha = 'b'.repeat(40);

  it('returns committed:false on clean tree (no commit attempted)', async () => {
    const { runner, received } = scriptRunner([{ args: ['status', '--porcelain'], result: ok('') }]);
    const result = await gitCommitWithMessage(runner, cwd, 'task(abc): hello');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.committed).toBe(false);
    expect(received).toHaveLength(1);
  });

  it('stages, commits, and resolves new HEAD on a dirty tree', async () => {
    const { runner } = scriptRunner([
      { args: ['status', '--porcelain'], result: ok(' M file\n') },
      { args: ['add', '-A'], result: ok() },
      { args: ['status', '--porcelain'], result: ok('M  file\n') },
      { args: ['commit', '-m', 'task(abc): hello'], result: ok() },
      { args: ['rev-parse', 'HEAD'], result: ok(`${sha}\n`) },
    ]);
    const result = await gitCommitWithMessage(runner, cwd, 'task(abc): hello');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ committed: true, headSha: sha });
  });

  it('returns committed:false when index is empty after add (e.g. all .gitignored)', async () => {
    const { runner } = scriptRunner([
      { args: ['status', '--porcelain'], result: ok(' M file\n') },
      { args: ['add', '-A'], result: ok() },
      { args: ['status', '--porcelain'], result: ok('') },
    ]);
    const result = await gitCommitWithMessage(runner, cwd, 'task(abc): hello');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.committed).toBe(false);
  });

  it('rejects empty commit message', async () => {
    const { runner } = scriptRunner([]);
    const result = await gitCommitWithMessage(runner, cwd, '');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('empty');
  });

  it('accepts a long multi-paragraph commit message verbatim (audit-[03]: no caps on AI signal bodies)', async () => {
    // Commit messages are AI signal bodies — `subject` + `body` from the validated
    // `commit-message` signal land verbatim on the commit. `git commit -m <msg>` passes via
    // argv with ARG_MAX headroom in the hundreds of KB; git itself has no length limit.
    const message = `feat(x): a fat conventional commit\n\n${'lorem ipsum '.repeat(200).trim()}`;
    const { runner, received } = scriptRunner([
      { args: ['status', '--porcelain'], result: ok(' M file\n') },
      { args: ['add', '-A'], result: ok() },
      { args: ['status', '--porcelain'], result: ok('M  file\n') },
      { args: ['commit', '-m', message], result: ok() },
      { args: ['rev-parse', 'HEAD'], result: ok(`${sha}\n`) },
    ]);
    const result = await gitCommitWithMessage(runner, cwd, message);
    expect(result.ok).toBe(true);
    expect(received[3]?.args[2]).toBe(message);
  });

  it('preserves quotes and special chars verbatim through argv', async () => {
    const message = `task(x): \`$foo\` "quotes"`;
    const { runner, received } = scriptRunner([
      { args: ['status', '--porcelain'], result: ok(' M file\n') },
      { args: ['add', '-A'], result: ok() },
      { args: ['status', '--porcelain'], result: ok('M  file\n') },
      { args: ['commit', '-m', message], result: ok() },
      { args: ['rev-parse', 'HEAD'], result: ok(`${sha}\n`) },
    ]);
    const result = await gitCommitWithMessage(runner, cwd, message);
    expect(result.ok).toBe(true);
    expect(received[3]?.args[2]).toBe(message);
  });
});

describe('gitStashPush', () => {
  it('returns stashed:false on clean tree', async () => {
    const { runner } = scriptRunner([{ args: ['status', '--porcelain'], result: ok('') }]);
    const result = await gitStashPush(runner, cwd, 'preflight-stash');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.stashed).toBe(false);
  });

  it('stashes when dirty', async () => {
    const { runner } = scriptRunner([
      { args: ['status', '--porcelain'], result: ok(' M file\n') },
      { args: ['stash', 'push', '-u', '-m', 'preflight-stash'], result: ok() },
    ]);
    const result = await gitStashPush(runner, cwd, 'preflight-stash');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.stashed).toBe(true);
  });
});

describe('gitGetCurrentBranch', () => {
  it('returns the branch name on success', async () => {
    const { runner } = scriptRunner([{ args: ['rev-parse', '--abbrev-ref', 'HEAD'], result: ok('main\n') }]);
    const result = await gitGetCurrentBranch(runner, cwd);
    expect(result.ok && result.value).toBe('main');
  });

  it('returns HEAD verbatim when detached', async () => {
    const { runner } = scriptRunner([{ args: ['rev-parse', '--abbrev-ref', 'HEAD'], result: ok('HEAD\n') }]);
    const result = await gitGetCurrentBranch(runner, cwd);
    expect(result.ok && result.value).toBe('HEAD');
  });

  it('surfaces non-zero exit as StorageError', async () => {
    const { runner } = scriptRunner([
      { args: ['rev-parse', '--abbrev-ref', 'HEAD'], result: ok('', 128, 'fatal: not a git repository') },
    ]);
    const result = await gitGetCurrentBranch(runner, cwd);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('not a git repository');
  });
});

describe('gitBranchExists', () => {
  it('true on exit 0', async () => {
    const { runner } = scriptRunner([{ args: ['show-ref', '--verify', '--quiet', 'refs/heads/main'], result: ok() }]);
    const result = await gitBranchExists(runner, cwd, 'main');
    expect(result.ok && result.value).toBe(true);
  });

  it('false on non-zero exit (absent)', async () => {
    const { runner } = scriptRunner([
      { args: ['show-ref', '--verify', '--quiet', 'refs/heads/feature'], result: ok('', 1) },
    ]);
    const result = await gitBranchExists(runner, cwd, 'feature');
    expect(result.ok && result.value).toBe(false);
  });
});

describe('gitCreateAndCheckoutBranch', () => {
  it('no-op when already on the branch', async () => {
    const { runner, received } = scriptRunner([
      { args: ['rev-parse', '--abbrev-ref', 'HEAD'], result: ok('ralphctl/abc\n') },
    ]);
    const result = await gitCreateAndCheckoutBranch(runner, cwd, 'ralphctl/abc');
    expect(result.ok).toBe(true);
    expect(received).toHaveLength(1);
  });

  it('checkout existing branch when it exists locally', async () => {
    const { runner, received } = scriptRunner([
      { args: ['rev-parse', '--abbrev-ref', 'HEAD'], result: ok('main\n') },
      { args: ['show-ref', '--verify', '--quiet', 'refs/heads/ralphctl/abc'], result: ok() },
      { args: ['checkout', 'ralphctl/abc'], result: ok() },
    ]);
    const result = await gitCreateAndCheckoutBranch(runner, cwd, 'ralphctl/abc');
    expect(result.ok).toBe(true);
    expect(received[2]?.args).toEqual(['checkout', 'ralphctl/abc']);
  });

  it('checkout -b when the branch does not exist', async () => {
    const { runner, received } = scriptRunner([
      { args: ['rev-parse', '--abbrev-ref', 'HEAD'], result: ok('main\n') },
      { args: ['show-ref', '--verify', '--quiet', 'refs/heads/ralphctl/abc'], result: ok('', 1) },
      { args: ['checkout', '-b', 'ralphctl/abc'], result: ok() },
    ]);
    const result = await gitCreateAndCheckoutBranch(runner, cwd, 'ralphctl/abc');
    expect(result.ok).toBe(true);
    expect(received[2]?.args).toEqual(['checkout', '-b', 'ralphctl/abc']);
  });

  it('surfaces checkout failure as StorageError', async () => {
    const { runner } = scriptRunner([
      { args: ['rev-parse', '--abbrev-ref', 'HEAD'], result: ok('main\n') },
      { args: ['show-ref', '--verify', '--quiet', 'refs/heads/ralphctl/abc'], result: ok() },
      { args: ['checkout', 'ralphctl/abc'], result: ok('', 1, 'error: pathspec did not match') },
    ]);
    const result = await gitCreateAndCheckoutBranch(runner, cwd, 'ralphctl/abc');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('pathspec did not match');
  });
});

describe('gitResetHard', () => {
  it('runs reset --hard HEAD then clean -fd', async () => {
    const { runner, received } = scriptRunner([
      { args: ['reset', '--hard', 'HEAD'], result: ok() },
      { args: ['clean', '-fd'], result: ok() },
    ]);
    const result = await gitResetHard(runner, cwd);
    expect(result.ok).toBe(true);
    expect(received.map((c) => c.args[0])).toEqual(['reset', 'clean']);
  });

  it('surfaces clean failure as StorageError', async () => {
    const { runner } = scriptRunner([
      { args: ['reset', '--hard', 'HEAD'], result: ok() },
      { args: ['clean', '-fd'], result: ok('', 1, 'permission denied') },
    ]);
    const result = await gitResetHard(runner, cwd);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('permission denied');
  });
});
