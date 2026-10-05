import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { type StorageError } from '@src/domain/value/error/storage-error.ts';
import { gitStashInspect, gitStashList, gitStashPop, gitStashPush } from '@src/integration/io/git-stash.ts';
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
describe('gitStashPush', () => {
  it('returns stashed:false on clean tree', async () => {
    const { runner } = scriptRunner([{ args: ['status', '--porcelain', '--untracked-files=normal'], result: ok('') }]);
    const result = await gitStashPush(runner, cwd, 'preflight-stash');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.stashed).toBe(false);
  });

  it('stashes when dirty', async () => {
    const { runner } = scriptRunner([
      { args: ['status', '--porcelain', '--untracked-files=normal'], result: ok(' M file\n') },
      { args: ['stash', 'push', '-u', '-m', 'preflight-stash'], result: ok() },
    ]);
    const result = await gitStashPush(runner, cwd, 'preflight-stash');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.stashed).toBe(true);
  });
});

describe('gitStashList', () => {
  it('returns empty list on an empty stash', async () => {
    const { runner } = scriptRunner([{ args: ['stash', 'list', '--format=%s'], result: ok('') }]);
    const result = await gitStashList(runner, cwd);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual([]);
  });

  it('returns subjects in order, dropping the trailing blank line', async () => {
    const { runner } = scriptRunner([{ args: ['stash', 'list', '--format=%s'], result: ok('msg1\nmsg2\n') }]);
    const result = await gitStashList(runner, cwd);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual(['msg1', 'msg2']);
  });

  it('surfaces non-zero exit as StorageError', async () => {
    const { runner } = scriptRunner([
      { args: ['stash', 'list', '--format=%s'], result: ok('', 128, 'fatal: not a git repository') },
    ]);
    const result = await gitStashList(runner, cwd);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('not a git repository');
  });
});

describe('gitStashPop', () => {
  it('no-ops with popped:false when the message is not in the stash', async () => {
    const { runner, received } = scriptRunner([
      { args: ['stash', 'list', '--format=%s'], result: ok('other-stash\n') },
    ]);
    const result = await gitStashPop(runner, cwd, 'ralphctl-blocked-diff');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.popped).toBe(false);
    // Only the list call was issued — no pop.
    expect(received).toHaveLength(1);
  });

  it('pops the entry at index 0', async () => {
    const { runner, received } = scriptRunner([
      { args: ['stash', 'list', '--format=%s'], result: ok('ralphctl-blocked-diff\nother\n') },
      { args: ['stash', 'pop', 'stash@{0}'], result: ok() },
    ]);
    const result = await gitStashPop(runner, cwd, 'ralphctl-blocked-diff');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.popped).toBe(true);
    expect(received[1]?.args).toEqual(['stash', 'pop', 'stash@{0}']);
  });

  it('pops the entry at index 2 (third stash entry)', async () => {
    const { runner, received } = scriptRunner([
      { args: ['stash', 'list', '--format=%s'], result: ok('a\nb\nralphctl-blocked-diff\n') },
      { args: ['stash', 'pop', 'stash@{2}'], result: ok() },
    ]);
    const result = await gitStashPop(runner, cwd, 'ralphctl-blocked-diff');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.popped).toBe(true);
    expect(received[1]?.args).toEqual(['stash', 'pop', 'stash@{2}']);
  });

  it('surfaces a non-zero pop exit as StorageError', async () => {
    const { runner } = scriptRunner([
      { args: ['stash', 'list', '--format=%s'], result: ok('ralphctl-blocked-diff\n') },
      { args: ['stash', 'pop', 'stash@{0}'], result: ok('', 1, 'CONFLICT: merge conflict') },
    ]);
    const result = await gitStashPop(runner, cwd, 'ralphctl-blocked-diff');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('CONFLICT');
  });

  it('matches real git subject rendering — `On <branch>: <message>` — not just the bare message', async () => {
    // git stash push -m <msg> renders the %s subject as `On <branch>: <msg>`; the bare form
    // never appears against a real repository, so equality-only matching silently no-ops.
    const { runner, received } = scriptRunner([
      { args: ['stash', 'list', '--format=%s'], result: ok('On main: other\nOn main: ralphctl-blocked-diff\n') },
      { args: ['stash', 'pop', 'stash@{1}'], result: ok() },
    ]);
    const result = await gitStashPop(runner, cwd, 'ralphctl-blocked-diff');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.popped).toBe(true);
    expect(received[1]?.args).toEqual(['stash', 'pop', 'stash@{1}']);
  });

  it('matches the detached-HEAD rendering `On (no branch): <message>`', async () => {
    const { runner } = scriptRunner([
      { args: ['stash', 'list', '--format=%s'], result: ok('On (no branch): ralphctl-blocked-diff\n') },
      { args: ['stash', 'pop', 'stash@{0}'], result: ok() },
    ]);
    const result = await gitStashPop(runner, cwd, 'ralphctl-blocked-diff');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.popped).toBe(true);
  });

  it('does not match a subject where the message appears without the `: ` separator', async () => {
    // Precision guard for the suffix rule: a different stash whose subject merely CONTAINS the
    // message (e.g. a longer message sharing the tail) must not be popped by mistake.
    const { runner, received } = scriptRunner([
      { args: ['stash', 'list', '--format=%s'], result: ok('On main: prefix-ralphctl-blocked-diff\n') },
    ]);
    const result = await gitStashPop(runner, cwd, 'ralphctl-blocked-diff');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.popped).toBe(false);
    expect(received).toHaveLength(1);
  });
});

describe('gitStashInspect', () => {
  const MSG = 'ralphctl/s1/t1/blocked-diff';
  const LIST = ['stash', 'list', '--format=%gd%x1f%s'];
  const SHOW_FULL = (ref: string): string[] => ['stash', 'show', '--numstat', '--include-untracked', ref];
  const SHOW_TRACKED = (ref: string): string[] => ['stash', 'show', '--numstat', ref];

  it('counts every entry under the message and measures the newest one', async () => {
    const { runner } = scriptRunner([
      {
        args: LIST,
        result: ok(`stash@{0}\x1fOn main: other\nstash@{1}\x1fOn main: ${MSG}\nstash@{2}\x1fOn main: ${MSG}\n`),
      },
      { args: SHOW_FULL('stash@{1}'), result: ok('3\t1\tsrc/a.ts\n-\t-\tlogo.png\n10\t0\tnew.ts\n') },
    ]);
    const result = await gitStashInspect(runner, cwd, MSG);
    expect(result.ok && result.value).toEqual({
      entries: 2,
      newest: {
        ref: 'stash@{1}',
        stat: { files: 3, insertions: 13, deletions: 1 },
        files: [
          { path: 'src/a.ts', insertions: 3, deletions: 1 },
          { path: 'logo.png', insertions: 0, deletions: 0, binary: true },
          { path: 'new.ts', insertions: 10, deletions: 0 },
        ],
      },
    });
  });

  it('reports zero entries without running stash show when nothing matches', async () => {
    const { runner, received } = scriptRunner([{ args: LIST, result: ok(`stash@{0}\x1fOn main: prefix-${MSG}\n`) }]);
    const result = await gitStashInspect(runner, cwd, MSG);
    expect(result.ok && result.value).toEqual({ entries: 0 });
    expect(received).toHaveLength(1);
  });

  it('falls back to a tracked-only stat marked partial when --include-untracked is rejected', async () => {
    const { runner } = scriptRunner([
      { args: LIST, result: ok(`stash@{0}\x1fOn main: ${MSG}\n`) },
      { args: SHOW_FULL('stash@{0}'), result: ok('', 129, "error: unknown option `include-untracked'") },
      { args: SHOW_TRACKED('stash@{0}'), result: ok('2\t2\tsrc/a.ts\n') },
    ]);
    const result = await gitStashInspect(runner, cwd, MSG);
    expect(result.ok && result.value.newest?.stat).toEqual({ files: 1, insertions: 2, deletions: 2, partial: true });
  });

  it('bubbles the error when both stash show forms fail', async () => {
    const { runner } = scriptRunner([
      { args: LIST, result: ok(`stash@{0}\x1fOn main: ${MSG}\n`) },
      { args: SHOW_FULL('stash@{0}'), result: ok('', 128, 'fatal') },
      { args: SHOW_TRACKED('stash@{0}'), result: ok('', 128, 'fatal') },
    ]);
    const result = await gitStashInspect(runner, cwd, MSG);
    expect(result.ok).toBe(false);
  });

  it('bubbles a stash list failure rather than reporting an empty stash', async () => {
    const { runner } = scriptRunner([{ args: LIST, result: ok('', 128, 'fatal: not a git repository') }]);
    const result = await gitStashInspect(runner, cwd, MSG);
    expect(result.ok).toBe(false);
  });

  it('waits for an in-flight push before listing, so the resolved ref cannot go stale', async () => {
    const order: string[] = [];
    let releaseStatus: () => void = () => {};
    const statusGate = new Promise<void>((resolve) => {
      releaseStatus = resolve;
    });
    const runner: GitRunner = {
      async run(_, args) {
        order.push(args.slice(0, 2).join(' '));
        if (args[0] === 'status') {
          await statusGate;
          return ok(' M a.ts\n');
        }
        if (args[0] === 'stash' && args[1] === 'list') return ok(`stash@{0}\x1fOn main: ${MSG}\n`);
        return ok('1\t0\ta.ts\n');
      },
    };
    const push = gitStashPush(runner, cwd, MSG);
    const inspect = gitStashInspect(runner, cwd, MSG);
    await Promise.resolve();
    expect(order).toEqual(['status --porcelain']);
    releaseStatus();
    await Promise.all([push, inspect]);
    expect(order).toEqual(['status --porcelain', 'stash push', 'stash list', 'stash show']);
  });
});
