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

/** Scripted runner keyed by the git subcommand (`status` / `diff`). */
const runner = (responses: {
  status: Result<GitRunResult, StorageError>;
  diff?: Result<GitRunResult, StorageError>;
}): GitRunner => ({
  async run(_cwd, args) {
    if (args[0] === 'status') return responses.status;
    if (args[0] === 'diff') return responses.diff ?? Result.ok({ stdout: '', stderr: '', exitCode: 0 });
    throw new Error(`unexpected git ${args.join(' ')}`);
  },
});

const ok = (stdout: string): Result<GitRunResult, StorageError> => Result.ok({ stdout, stderr: '', exitCode: 0 });

describe('computeWorkProductFingerprint', () => {
  it('produces a stable hash for identical status + diff output', async () => {
    const a = await computeWorkProductFingerprint(
      runner({ status: ok(' M src/a.ts\n'), diff: ok('@@ -1 +1 @@\n') }),
      CWD
    );
    const b = await computeWorkProductFingerprint(
      runner({ status: ok(' M src/a.ts\n'), diff: ok('@@ -1 +1 @@\n') }),
      CWD
    );
    expect(a).toBeDefined();
    expect(a).toBe(b);
  });

  it('changes when the diff content changes even if the status line is identical', async () => {
    const a = await computeWorkProductFingerprint(
      runner({ status: ok(' M src/a.ts\n'), diff: ok('@@ -1 +1 @@\n-old\n') }),
      CWD
    );
    const b = await computeWorkProductFingerprint(
      runner({ status: ok(' M src/a.ts\n'), diff: ok('@@ -1 +1 @@\n-new\n') }),
      CWD
    );
    expect(a).not.toBe(b);
  });

  it('changes when an untracked file appears in status even if the diff is empty', async () => {
    // Untracked files show in `git status --porcelain` but NOT in `git diff HEAD`, so hashing
    // status (not just the diff) is what distinguishes them.
    const clean = await computeWorkProductFingerprint(runner({ status: ok(''), diff: ok('') }), CWD);
    const untracked = await computeWorkProductFingerprint(runner({ status: ok('?? src/new.ts\n'), diff: ok('') }), CWD);
    expect(clean).not.toBe(untracked);
  });

  it('returns undefined when git status fails (best-effort — degrades to the commit-subject proxy)', async () => {
    const result = await computeWorkProductFingerprint(
      runner({ status: Result.error(new StorageError({ subCode: 'io', message: 'git missing' })) }),
      CWD
    );
    expect(result).toBeUndefined();
  });

  it('returns undefined when git status exits non-zero', async () => {
    const result = await computeWorkProductFingerprint(
      runner({ status: Result.ok({ stdout: '', stderr: 'not a repo', exitCode: 128 }) }),
      CWD
    );
    expect(result).toBeUndefined();
  });

  it('returns undefined when git diff fails', async () => {
    const result = await computeWorkProductFingerprint(
      runner({ status: ok(' M a\n'), diff: Result.error(new StorageError({ subCode: 'io', message: 'boom' })) }),
      CWD
    );
    expect(result).toBeUndefined();
  });
});
