/**
 * `GitOperations` — high-level git wrappers used by the runtime
 * `ExternalPort` adapter.
 *
 * Each method maps to one or more `git ...` invocations through the
 * injected {@link GitRunner} seam. Pure-read methods stay synchronous
 * and total — they swallow git failures and return sensible defaults
 * (empty string, `null`, `[]`, `false`) so the rest of the harness can
 * keep going on best-effort information. Mutating methods are async and
 * Result-typed so the caller can decide whether a failure is fatal.
 *
 * Behavioural parity with the legacy implementation in
 * `src/integration/external/git.ts`:
 *  - `getCurrentBranch` returns `''` on non-git repos (legacy: throws —
 *    we soften it to match the {@link ExternalPort} contract which
 *    documents "empty string when not in a git repo").
 *  - `hasUncommittedChanges` returns `false` on non-git repos.
 *  - `getChangedFilesSince` validates the baseline against a hex-SHA
 *    pattern and returns `[]` for malformed values — never throws.
 *  - `autoCommit` honours pre-commit hooks (no `--no-verify`).
 *  - `autoCommit` emits `Result.error(StorageError({ subCode: 'no-changes',
 *    message: 'no changes' }))` when the repo is clean — callers detect
 *    the clean-tree no-op via `subCode === 'no-changes'` (legacy parity:
 *    we used to compare the message string, which was fragile).
 */
import { StorageError } from '../../domain/errors/storage-error.ts';
import { Result } from '../../domain/result.ts';
import type { AbsolutePath } from '../../domain/values/absolute-path.ts';
import { isValidBranchName } from './branch-name.ts';
import type { GitRunner } from './git-runner.ts';

const HEX_SHA_RE = /^[0-9a-f]{7,64}$/i;

/** Safe-to-pass-through-argv branch name — caller-side guard. */
function ensureValidBranch(name: string): Result<true, StorageError> {
  if (!isValidBranchName(name)) {
    return Result.error(new StorageError({ subCode: 'io', message: `invalid branch name: ${name}` }));
  }
  return Result.ok(true);
}

export class GitOperations {
  constructor(private readonly git: GitRunner) {}

  // --- Pure reads ------------------------------------------------------

  hasUncommittedChanges(cwd: AbsolutePath): boolean {
    const r = this.git.run({ cwd, args: ['status', '--porcelain'] });
    if (r.exitCode !== 0) return false;
    return r.stdout.trim().length > 0;
  }

  getCurrentBranch(cwd: AbsolutePath): string {
    const r = this.git.run({
      cwd,
      args: ['rev-parse', '--abbrev-ref', 'HEAD'],
    });
    if (r.exitCode !== 0) return '';
    return r.stdout.trim();
  }

  verifyBranch(cwd: AbsolutePath, expected: string): boolean {
    const current = this.getCurrentBranch(cwd);
    return current !== '' && current === expected;
  }

  getHeadSha(cwd: AbsolutePath): string | null {
    const r = this.git.run({ cwd, args: ['rev-parse', 'HEAD'] });
    if (r.exitCode !== 0) return null;
    return r.stdout.trim() || null;
  }

  getChangedFilesSince(cwd: AbsolutePath, baselineSha: string): readonly string[] {
    if (!HEX_SHA_RE.test(baselineSha)) return [];
    const files = new Set<string>();

    const diff = this.git.run({
      cwd,
      args: ['diff', '--name-only', `${baselineSha}..HEAD`],
    });
    if (diff.exitCode === 0) {
      for (const line of diff.stdout.split('\n')) {
        const trimmed = line.trim();
        if (trimmed) files.add(trimmed);
      }
    }

    const status = this.git.run({ cwd, args: ['status', '--porcelain'] });
    if (status.exitCode === 0) {
      for (const line of status.stdout.split('\n')) {
        // porcelain v1: `XY <path>` (or `XY <orig> -> <path>` for renames).
        const trimmed = line.replace(/^.{2}\s*/, '').trim();
        if (!trimmed) continue;
        const arrow = trimmed.split(' -> ');
        const path = arrow.length > 1 ? arrow[arrow.length - 1] : arrow[0];
        if (path) files.add(path);
      }
    }

    return [...files];
  }

  getRecentGitHistory(cwd: AbsolutePath, count: number): string {
    if (!Number.isInteger(count) || count <= 0) {
      return '(Unable to retrieve git history)';
    }
    const r = this.git.run({
      cwd,
      args: ['log', `-${String(count)}`, '--oneline', '--no-decorate'],
    });
    if (r.exitCode !== 0) return '(Unable to retrieve git history)';
    return r.stdout.trim();
  }

  /**
   * Resolve the URL of the `origin` remote (or `null` when missing). Used
   * by `createPullRequest` to detect GitHub vs GitLab.
   */
  getRemoteUrl(cwd: AbsolutePath, remote = 'origin'): string | null {
    const r = this.git.run({
      cwd,
      args: ['remote', 'get-url', remote],
    });
    if (r.exitCode !== 0) return null;
    const trimmed = r.stdout.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  // --- Mutations -------------------------------------------------------

  createAndCheckoutBranch(cwd: AbsolutePath, branch: string): Promise<Result<void, StorageError>> {
    return Promise.resolve(this.createAndCheckoutBranchSync(cwd, branch));
  }

  private createAndCheckoutBranchSync(cwd: AbsolutePath, branch: string): Result<void, StorageError> {
    const guard = ensureValidBranch(branch);
    if (!guard.ok) return Result.error(guard.error);

    // Already on the requested branch — idempotent.
    if (this.getCurrentBranch(cwd) === branch) {
      return Result.ok(undefined);
    }

    const exists = this.git.run({
      cwd,
      args: ['show-ref', '--verify', `refs/heads/${branch}`],
    });
    if (exists.exitCode === 0) {
      const checkout = this.git.run({ cwd, args: ['checkout', branch] });
      if (checkout.exitCode !== 0) {
        return Result.error(
          new StorageError({
            subCode: 'io',
            message: `failed to checkout '${branch}': ${(checkout.stderr || checkout.stdout).trim()}`,
          })
        );
      }
      return Result.ok(undefined);
    }

    const create = this.git.run({ cwd, args: ['checkout', '-b', branch] });
    if (create.exitCode !== 0) {
      return Result.error(
        new StorageError({
          subCode: 'io',
          message: `failed to create branch '${branch}': ${(create.stderr || create.stdout).trim()}`,
        })
      );
    }
    return Result.ok(undefined);
  }

  hardResetWorkingTree(cwd: AbsolutePath): Promise<Result<void, StorageError>> {
    const reset = this.git.run({ cwd, args: ['reset', '--hard', 'HEAD'] });
    if (reset.exitCode !== 0) {
      return Promise.resolve(
        Result.error(
          new StorageError({
            subCode: 'io',
            message: `failed to reset working tree: ${(reset.stderr || reset.stdout).trim()}`,
          })
        )
      );
    }
    const clean = this.git.run({ cwd, args: ['clean', '-fd'] });
    if (clean.exitCode !== 0) {
      return Promise.resolve(
        Result.error(
          new StorageError({
            subCode: 'io',
            message: `failed to clean working tree: ${(clean.stderr || clean.stdout).trim()}`,
          })
        )
      );
    }
    return Promise.resolve(Result.ok(undefined));
  }

  /**
   * Stage all changes and create a commit. Honours pre-commit hooks (no
   * `--no-verify`).
   *
   * Returns `Result.error(StorageError({ subCode: 'no-changes', message:
   * 'no changes' }))` when the working tree is clean — callers detect the
   * clean-tree no-op via `subCode === 'no-changes'` (e.g. the dirty-tree
   * fence treats a clean tree as a no-op).
   */
  autoCommit(cwd: AbsolutePath, message: string): Promise<Result<void, StorageError>> {
    if (!this.hasUncommittedChanges(cwd)) {
      return Promise.resolve(Result.error(new StorageError({ subCode: 'no-changes', message: 'no changes' })));
    }

    const add = this.git.run({ cwd, args: ['add', '-A'] });
    if (add.exitCode !== 0) {
      return Promise.resolve(
        Result.error(
          new StorageError({
            subCode: 'io',
            message: `failed to stage changes: ${(add.stderr || add.stdout).trim()}`,
          })
        )
      );
    }

    const commit = this.git.run({ cwd, args: ['commit', '-m', message] });
    if (commit.exitCode !== 0) {
      return Promise.resolve(
        Result.error(
          new StorageError({
            subCode: 'io',
            message: `failed to commit: ${(commit.stderr || commit.stdout).trim()}`,
          })
        )
      );
    }

    return Promise.resolve(Result.ok(undefined));
  }

  /**
   * Stash all uncommitted + untracked changes with a recoverable message.
   * Returns `Result.error(StorageError({ subCode: 'no-changes' }))` when
   * the tree is already clean — callers treat that as a no-op. Other
   * git failures surface as `subCode: 'io'` with the captured stderr.
   */
  stashChanges(cwd: AbsolutePath, message: string): Promise<Result<void, StorageError>> {
    if (!this.hasUncommittedChanges(cwd)) {
      return Promise.resolve(Result.error(new StorageError({ subCode: 'no-changes', message: 'no changes to stash' })));
    }
    const stash = this.git.run({ cwd, args: ['stash', 'push', '-u', '-m', message] });
    if (stash.exitCode !== 0) {
      return Promise.resolve(
        Result.error(
          new StorageError({
            subCode: 'io',
            message: `failed to stash changes: ${(stash.stderr || stash.stdout).trim()}`,
          })
        )
      );
    }
    return Promise.resolve(Result.ok(undefined));
  }
}
