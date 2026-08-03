import { Result } from '@src/domain/result.ts';
import type { GitRunner, GitRunResult } from '@src/integration/io/git-runner.ts';
import type { StorageError } from '@src/domain/value/error/storage-error.ts';

/**
 * Canonical scripted success `Result` for a `GitRunner.run()` call — the byte-identical helper
 * previously hand-rolled at the top of every e2e flow test that scripts git plumbing (implement,
 * review, sprint-lifecycle, distill-step). One definition so a future `GitRunResult` shape change
 * only needs updating here.
 */
export const okGit = (stdout = '', exitCode = 0): Result<GitRunResult, StorageError> =>
  Result.ok({ stdout, stderr: '', exitCode });

/**
 * A `GitRunner` whose `run()` always resolves the same scripted `okGit(...)` result regardless of
 * the args it's called with — the shape `working-tree-clean-check.test.ts` needs (a single
 * canned porcelain/exit-code pair per test case, not a per-arg script).
 */
export const stubGitRunner = (stdout = '', exitCode = 0): GitRunner => ({
  async run() {
    return okGit(stdout, exitCode);
  },
});
