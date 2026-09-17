import { describe, expect, it } from 'vitest';

import { Result } from '@src/domain/result.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { GitRunner, GitRunResult } from '@src/integration/io/git-runner.ts';
import {
  gitDiscardEntries,
  gitStatusSnapshot,
  porcelainEntryKey,
  porcelainEntryPaths,
  type PorcelainEntry,
} from '@src/integration/io/git-tree-snapshot.ts';

import { absolutePath } from '@tests/fixtures/domain.ts';
import { okGit } from '@tests/fixtures/git-result.ts';

const CWD = absolutePath('/tmp/snapshot-repo');

interface Scripted {
  readonly runner: GitRunner;
  readonly calls: string[][];
}

const scripted = (reply: (args: readonly string[]) => Result<GitRunResult, StorageError>): Scripted => {
  const calls: string[][] = [];
  return {
    calls,
    runner: {
      async run(_cwd, args) {
        calls.push([...args]);
        return reply(args);
      },
    },
  };
};

describe('gitStatusSnapshot', () => {
  it('reads NUL-separated porcelain v1 with untracked files forced on', async () => {
    const git = scripted(() => okGit(' M pnpm-lock.yaml\0?? gen/\0', 0));

    const snap = await gitStatusSnapshot(git.runner, CWD);

    expect(git.calls).toStrictEqual([['status', '--porcelain=v1', '-z', '--untracked-files=normal']]);
    expect(snap.ok && snap.value).toStrictEqual([
      { xy: ' M', path: 'pnpm-lock.yaml' },
      { xy: '??', path: 'gen/' },
    ]);
  });

  it('pairs a rename with its source path from the following record', async () => {
    const git = scripted(() => okGit('R  src/new.ts\0src/old.ts\0 M after.ts\0', 0));

    const snap = await gitStatusSnapshot(git.runner, CWD);

    expect(snap.ok && snap.value).toStrictEqual([
      { xy: 'R ', path: 'src/new.ts', origPath: 'src/old.ts' },
      { xy: ' M', path: 'after.ts' },
    ]);
  });

  it('pairs a copy the same way', async () => {
    const git = scripted(() => okGit('C  copy.ts\0orig.ts\0', 0));

    const snap = await gitStatusSnapshot(git.runner, CWD);

    expect(snap.ok && snap.value).toStrictEqual([{ xy: 'C ', path: 'copy.ts', origPath: 'orig.ts' }]);
  });

  it('keeps spaces, quotes and non-ASCII characters in paths verbatim', async () => {
    const git = scripted(() => okGit('?? sp ace.txt\0 M ü "q".txt\0', 0));

    const snap = await gitStatusSnapshot(git.runner, CWD);

    expect(snap.ok && snap.value.map((e) => e.path)).toStrictEqual(['sp ace.txt', 'ü "q".txt']);
  });

  it('reads an empty tree as no entries', async () => {
    const snap = await gitStatusSnapshot(scripted(() => okGit('', 0)).runner, CWD);
    expect(snap.ok && snap.value).toStrictEqual([]);
  });

  it('turns a non-zero exit into a StorageError, never an empty tree', async () => {
    const git = scripted(() => Result.ok({ stdout: '', stderr: 'fatal: not a git repository', exitCode: 128 }));

    const snap = await gitStatusSnapshot(git.runner, CWD);

    expect(snap.ok).toBe(false);
    if (!snap.ok) {
      expect(snap.error).toBeInstanceOf(StorageError);
      expect(snap.error.message).toContain('not a git repository');
    }
  });

  it('passes a runner failure through', async () => {
    const failure = new StorageError({ subCode: 'io', message: 'spawn git ENOENT' });
    const snap = await gitStatusSnapshot(scripted(() => Result.error(failure)).runner, CWD);
    expect(!snap.ok && snap.error).toBe(failure);
  });
});

describe('porcelainEntryKey / porcelainEntryPaths', () => {
  it('distinguishes the same path under a different status', () => {
    expect(porcelainEntryKey({ xy: ' M', path: 'a' })).not.toBe(porcelainEntryKey({ xy: 'MM', path: 'a' }));
  });

  it('distinguishes renames from the same destination', () => {
    expect(porcelainEntryKey({ xy: 'R ', path: 'a', origPath: 'b' })).not.toBe(
      porcelainEntryKey({ xy: 'R ', path: 'a', origPath: 'c' })
    );
  });

  it('lists a rename by both paths', () => {
    expect(porcelainEntryPaths({ xy: 'R ', path: 'new', origPath: 'old' })).toStrictEqual(['new', 'old']);
    expect(porcelainEntryPaths({ xy: ' M', path: 'a' })).toStrictEqual(['a']);
  });
});

describe('gitDiscardEntries', () => {
  it('restores tracked entries from HEAD and cleans untracked ones, each path taken literally', async () => {
    const git = scripted(() => okGit('', 0));
    const entries: PorcelainEntry[] = [
      { xy: ' M', path: 'pnpm-lock.yaml' },
      { xy: '??', path: 'gen/' },
      { xy: 'R ', path: 'new.ts', origPath: 'old.ts' },
      { xy: '??', path: 'sp ace.txt' },
    ];

    const out = await gitDiscardEntries(git.runner, CWD, entries);

    expect(out.ok).toBe(true);
    expect(git.calls).toStrictEqual([
      [
        'restore',
        '--source=HEAD',
        '--staged',
        '--worktree',
        '--',
        ':(literal)pnpm-lock.yaml',
        ':(literal)new.ts',
        ':(literal)old.ts',
      ],
      ['clean', '-f', '-d', '--', ':(literal)gen/', ':(literal)sp ace.txt'],
    ]);
  });

  it('never runs clean with -x, so ignored files survive', async () => {
    const git = scripted(() => okGit('', 0));
    await gitDiscardEntries(git.runner, CWD, [{ xy: '??', path: 'gen/' }]);
    expect(git.calls.flat()).not.toContain('-x');
    expect(git.calls.flat()).not.toContain('-X');
  });

  it('runs nothing for an empty list', async () => {
    const git = scripted(() => okGit('', 0));
    const out = await gitDiscardEntries(git.runner, CWD, []);
    expect(out.ok).toBe(true);
    expect(git.calls).toStrictEqual([]);
  });

  it('splits long path lists into calls of at most 100 pathspecs', async () => {
    const git = scripted(() => okGit('', 0));
    const entries = Array.from({ length: 250 }, (_, i): PorcelainEntry => ({ xy: '??', path: `f${String(i)}` }));

    await gitDiscardEntries(git.runner, CWD, entries);

    const pathspecCounts = git.calls.map((c) => c.length - c.indexOf('--') - 1);
    expect(pathspecCounts).toStrictEqual([100, 100, 50]);
    expect(git.calls.flatMap((c) => c.slice(c.indexOf('--') + 1))).toHaveLength(250);
  });

  it('stops at the first non-zero exit and reports it as a StorageError', async () => {
    const git = scripted((args) =>
      args[0] === 'restore'
        ? Result.ok({ stdout: '', stderr: "error: pathspec 'x' did not match", exitCode: 1 })
        : okGit('', 0)
    );

    const out = await gitDiscardEntries(git.runner, CWD, [
      { xy: ' M', path: 'x' },
      { xy: '??', path: 'y' },
    ]);

    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error).toBeInstanceOf(StorageError);
      expect(out.error.message).toContain('did not match');
    }
    expect(git.calls.map((c) => c[0])).toStrictEqual(['restore']);
  });
});
