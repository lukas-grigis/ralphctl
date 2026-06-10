import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { GitRunner, GitRunResult } from '@src/integration/io/git-runner.ts';
import { computeWorkProductFingerprint } from '@src/application/flows/implement/leaves/work-product-fingerprint.ts';

const CWD = (() => {
  const r = AbsolutePath.parse('/tmp/ralph/repo');
  if (!r.ok) throw new Error('bad path');
  return r.value;
})();

/** Scripted runner keyed by the git subcommand (`status` / `diff` / `ls-files` / `hash-object`). */
const runner = (responses: {
  status: Result<GitRunResult, StorageError>;
  diff?: Result<GitRunResult, StorageError>;
  lsFiles?: Result<GitRunResult, StorageError>;
  hashObject?: Result<GitRunResult, StorageError>;
}): { git: GitRunner; calls: string[][] } => {
  const calls: string[][] = [];
  const git: GitRunner = {
    async run(_cwd, args) {
      calls.push([...args]);
      if (args[0] === 'status') return responses.status;
      if (args[0] === 'diff') return responses.diff ?? Result.ok({ stdout: '', stderr: '', exitCode: 0 });
      if (args[0] === 'ls-files') return responses.lsFiles ?? Result.ok({ stdout: '', stderr: '', exitCode: 0 });
      if (args[0] === 'hash-object') return responses.hashObject ?? Result.ok({ stdout: '', stderr: '', exitCode: 0 });
      throw new Error(`unexpected git ${args.join(' ')}`);
    },
  };
  return { git, calls };
};

const ok = (stdout: string): Result<GitRunResult, StorageError> => Result.ok({ stdout, stderr: '', exitCode: 0 });

describe('computeWorkProductFingerprint', () => {
  it('produces a stable hash for identical status + diff + untracked output', async () => {
    const a = await computeWorkProductFingerprint(
      runner({ status: ok(' M src/a.ts\n'), diff: ok('@@ -1 +1 @@\n') }).git,
      CWD
    );
    const b = await computeWorkProductFingerprint(
      runner({ status: ok(' M src/a.ts\n'), diff: ok('@@ -1 +1 @@\n') }).git,
      CWD
    );
    expect(a).toBeDefined();
    expect(a).toBe(b);
  });

  it('changes when the diff content changes even if the status line is identical', async () => {
    const a = await computeWorkProductFingerprint(
      runner({ status: ok(' M src/a.ts\n'), diff: ok('@@ -1 +1 @@\n-old\n') }).git,
      CWD
    );
    const b = await computeWorkProductFingerprint(
      runner({ status: ok(' M src/a.ts\n'), diff: ok('@@ -1 +1 @@\n-new\n') }).git,
      CWD
    );
    expect(a).not.toBe(b);
  });

  it('changes when an untracked file appears in status even if the diff is empty', async () => {
    // Untracked files show in `git status --porcelain` but NOT in `git diff HEAD`, so hashing
    // status (not just the diff) is what distinguishes them.
    const clean = await computeWorkProductFingerprint(runner({ status: ok(''), diff: ok('') }).git, CWD);
    const untracked = await computeWorkProductFingerprint(
      runner({ status: ok('?? src/new.ts\n'), diff: ok(''), lsFiles: ok('src/new.ts\n'), hashObject: ok('aaa111\n') })
        .git,
      CWD
    );
    expect(clean).not.toBe(untracked);
  });

  it('changes when ONLY an untracked file’s CONTENT changes between rounds — the new-file task shape', async () => {
    // The deliverable is a brand-new file: round N and round N+1 have byte-identical porcelain
    // status ('?? src/new.ts') and an empty `diff HEAD` (untracked content never appears there).
    // Only the blob hash of the untracked file differs — without hashing it, both rounds would
    // fingerprint identically and the plateau predicate would false-fire on genuine progress.
    const base = { status: ok('?? src/new.ts\n'), diff: ok(''), lsFiles: ok('src/new.ts\n') };
    const round1 = await computeWorkProductFingerprint(runner({ ...base, hashObject: ok('aaa111\n') }).git, CWD);
    const round2 = await computeWorkProductFingerprint(runner({ ...base, hashObject: ok('bbb222\n') }).git, CWD);
    expect(round1).toBeDefined();
    expect(round2).toBeDefined();
    expect(round1).not.toBe(round2);
  });

  it('lists untracked paths via ls-files (never porcelain’s collapsed `?? dir/` form) and skips hash-object when none exist', async () => {
    const { git, calls } = runner({ status: ok(' M src/a.ts\n'), diff: ok('@@\n'), lsFiles: ok('') });
    await computeWorkProductFingerprint(git, CWD);
    expect(calls.some((c) => c[0] === 'ls-files' && c.includes('--others') && c.includes('--exclude-standard'))).toBe(
      true
    );
    // No untracked paths → the hash-object spawn is skipped entirely.
    expect(calls.some((c) => c[0] === 'hash-object')).toBe(false);
  });

  it('returns undefined when git status fails (best-effort — conservative no-exemption downstream)', async () => {
    const result = await computeWorkProductFingerprint(
      runner({ status: Result.error(new StorageError({ subCode: 'io', message: 'git missing' })) }).git,
      CWD
    );
    expect(result).toBeUndefined();
  });

  it('returns undefined when git status exits non-zero', async () => {
    const result = await computeWorkProductFingerprint(
      runner({ status: Result.ok({ stdout: '', stderr: 'not a repo', exitCode: 128 }) }).git,
      CWD
    );
    expect(result).toBeUndefined();
  });

  it('returns undefined when git diff fails', async () => {
    const result = await computeWorkProductFingerprint(
      runner({ status: ok(' M a\n'), diff: Result.error(new StorageError({ subCode: 'io', message: 'boom' })) }).git,
      CWD
    );
    expect(result).toBeUndefined();
  });

  it('returns undefined when hashing the untracked files fails', async () => {
    const result = await computeWorkProductFingerprint(
      runner({
        status: ok('?? src/new.ts\n'),
        diff: ok(''),
        lsFiles: ok('src/new.ts\n'),
        hashObject: Result.error(new StorageError({ subCode: 'io', message: 'boom' })),
      }).git,
      CWD
    );
    expect(result).toBeUndefined();
  });
});
