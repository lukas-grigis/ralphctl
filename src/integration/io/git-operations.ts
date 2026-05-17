import { Result } from '@src/domain/result.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { GitRunner } from '@src/integration/io/git-runner.ts';

/**
 * High-level git operations used by the implement and review chains.
 *
 * Function-first: each operation takes a `GitRunner` as first arg and the cwd second. No
 * shared class, no constructor — production composition root creates one runner and partial-
 * applies it; tests inject a fake runner directly.
 *
 * Scope: only the operations the harness needs. No branch creation, no remote URL lookup, no
 * history fetch — those belong to whichever chain wants them.
 *
 * Result conventions:
 *   - Pure reads: `Result<T, StorageError>`. The reads bubble system errors up; they don't
 *     swallow them like v1's defaults-returning version. The preflight gate only ever reads
 *     when the runner is healthy, so silent defaults aren't useful.
 *   - Mutations: `Result<T, StorageError>` with the new HEAD SHA / nothing on success and
 *     a captured-stderr storage error on failure.
 *   - "Nothing to do" is `Result.ok` with a payload, not an error. Specifically:
 *       - `gitCommitWithMessage` returns `{ committed: false }` on a clean tree;
 *       - `gitStashPush` returns `{ stashed: false }` on a clean tree.
 *     This avoids `StorageError({ subCode: 'no-changes' })` as a control-flow signal.
 */

const HEX_SHA_RE = /^[0-9a-f]{7,64}$/i;
// Per-task commits are signal, not prose — the harness writes machine-readable history, the
// AI's descriptive prose belongs in `progress.md`. 200 UTF-8 bytes is enough for a
// conventional-style subject plus a single short follow-up sentence; anything longer is
// truncated by the message factories upstream of this validator. Treat a breach as a bug
// (a factory failed to clamp) rather than a soft hint, so the chain halts loudly.
const COMMIT_MESSAGE_MAX_BYTES = 200;

export interface GitStatusEntry {
  readonly status: string;
  readonly path: string;
}

export interface CommitOutcome {
  readonly committed: boolean;
  readonly headSha?: string;
}

export interface StashOutcome {
  readonly stashed: boolean;
}

/**
 * Read the porcelain status of the working tree. Returns a parsed list of entries; an empty
 * list means clean. Bubbles unexpected git failures (e.g. not a git repo) as StorageError —
 * the preflight gate is explicit, so silent defaults would hide real problems.
 */
export const gitStatusPorcelain = async (
  runner: GitRunner,
  cwd: AbsolutePath
): Promise<Result<readonly GitStatusEntry[], StorageError>> => {
  const result = await runner.run(cwd, ['status', '--porcelain']);
  if (!result.ok) return Result.error(result.error);
  if (result.value.exitCode !== 0) {
    return Result.error(
      new StorageError({
        subCode: 'io',
        message: `git status failed: ${(result.value.stderr || result.value.stdout).trim()}`,
      })
    );
  }
  const entries: GitStatusEntry[] = [];
  for (const line of result.value.stdout.split('\n')) {
    if (line.length === 0) continue;
    // porcelain v1: `XY <path>` (or `XY <orig> -> <path>` for renames). XY is two columns.
    const status = line.slice(0, 2);
    const rest = line.slice(2).trimStart();
    if (rest.length === 0) continue;
    const arrow = rest.split(' -> ');
    const path = arrow.length > 1 ? arrow[arrow.length - 1] : arrow[0];
    if (path === undefined || path.length === 0) continue;
    entries.push({ status, path });
  }
  return Result.ok(entries);
};

/** True iff the working tree has any uncommitted changes (modified, staged, or untracked). */
export const gitHasUncommittedChanges = async (
  runner: GitRunner,
  cwd: AbsolutePath
): Promise<Result<boolean, StorageError>> => {
  const status = await gitStatusPorcelain(runner, cwd);
  if (!status.ok) return Result.error(status.error);
  return Result.ok(status.value.length > 0);
};

/** Resolve `HEAD` to a commit SHA. */
export const gitRevParseHead = async (runner: GitRunner, cwd: AbsolutePath): Promise<Result<string, StorageError>> => {
  const result = await runner.run(cwd, ['rev-parse', 'HEAD']);
  if (!result.ok) return Result.error(result.error);
  if (result.value.exitCode !== 0) {
    return Result.error(
      new StorageError({
        subCode: 'io',
        message: `git rev-parse HEAD failed: ${(result.value.stderr || result.value.stdout).trim()}`,
      })
    );
  }
  const sha = result.value.stdout.trim();
  if (!HEX_SHA_RE.test(sha)) {
    return Result.error(
      new StorageError({
        subCode: 'io',
        message: `git rev-parse HEAD returned non-SHA output: '${sha}'`,
      })
    );
  }
  return Result.ok(sha);
};

/** Stage every change in the working tree (including untracked files). */
export const gitAddAll = async (runner: GitRunner, cwd: AbsolutePath): Promise<Result<void, StorageError>> => {
  const result = await runner.run(cwd, ['add', '-A']);
  if (!result.ok) return Result.error(result.error);
  if (result.value.exitCode !== 0) {
    return Result.error(
      new StorageError({
        subCode: 'io',
        message: `git add -A failed: ${(result.value.stderr || result.value.stdout).trim()}`,
      })
    );
  }
  return Result.ok(undefined);
};

/**
 * Stage all changes and commit with the supplied message. Returns:
 *   - `{ committed: true, headSha }` on a successful commit
 *   - `{ committed: false }` if the tree was clean before staging or empty after staging
 *   - `Result.error(StorageError)` for anything else
 *
 * The message is passed via argv (no shell) so quotes / `$` / backticks / newlines are
 * preserved verbatim. Length is enforced at <=200 UTF-8 bytes — git itself accepts more,
 * but per-task commits are signal, not prose.
 */
export const gitCommitWithMessage = async (
  runner: GitRunner,
  cwd: AbsolutePath,
  message: string
): Promise<Result<CommitOutcome, StorageError>> => {
  const validated = validateCommitMessage(message);
  if (!validated.ok) return Result.error(validated.error);

  const beforeStage = await gitHasUncommittedChanges(runner, cwd);
  if (!beforeStage.ok) return Result.error(beforeStage.error);
  if (!beforeStage.value) return Result.ok({ committed: false });

  const staged = await gitAddAll(runner, cwd);
  if (!staged.ok) return Result.error(staged.error);

  // `git add -A` may have promoted untracked files but the index could still be empty (e.g.
  // everything was .gitignored). Re-check before commit so we surface "no changes" rather
  // than git's confusing "nothing to commit" failure path.
  const afterStage = await gitHasUncommittedChanges(runner, cwd);
  if (!afterStage.ok) return Result.error(afterStage.error);
  if (!afterStage.value) return Result.ok({ committed: false });

  const commit = await runner.run(cwd, ['commit', '-m', message]);
  if (!commit.ok) return Result.error(commit.error);
  if (commit.value.exitCode !== 0) {
    return Result.error(
      new StorageError({
        subCode: 'io',
        message: `git commit failed: ${(commit.value.stderr || commit.value.stdout).trim()}`,
      })
    );
  }
  const head = await gitRevParseHead(runner, cwd);
  if (!head.ok) return Result.error(head.error);
  return Result.ok({ committed: true, headSha: head.value });
};

/**
 * Stash all uncommitted + untracked changes with a recoverable message. Returns
 * `{ stashed: false }` on a clean tree (callers treat it as a no-op).
 */
export const gitStashPush = async (
  runner: GitRunner,
  cwd: AbsolutePath,
  message: string
): Promise<Result<StashOutcome, StorageError>> => {
  const dirty = await gitHasUncommittedChanges(runner, cwd);
  if (!dirty.ok) return Result.error(dirty.error);
  if (!dirty.value) return Result.ok({ stashed: false });

  const stash = await runner.run(cwd, ['stash', 'push', '-u', '-m', message]);
  if (!stash.ok) return Result.error(stash.error);
  if (stash.value.exitCode !== 0) {
    return Result.error(
      new StorageError({
        subCode: 'io',
        message: `git stash push failed: ${(stash.value.stderr || stash.value.stdout).trim()}`,
      })
    );
  }
  return Result.ok({ stashed: true });
};

/** `git reset --hard HEAD` followed by `git clean -fd`. Wipes uncommitted + untracked. */
export const gitResetHard = async (runner: GitRunner, cwd: AbsolutePath): Promise<Result<void, StorageError>> => {
  const reset = await runner.run(cwd, ['reset', '--hard', 'HEAD']);
  if (!reset.ok) return Result.error(reset.error);
  if (reset.value.exitCode !== 0) {
    return Result.error(
      new StorageError({
        subCode: 'io',
        message: `git reset --hard failed: ${(reset.value.stderr || reset.value.stdout).trim()}`,
      })
    );
  }
  const clean = await runner.run(cwd, ['clean', '-fd']);
  if (!clean.ok) return Result.error(clean.error);
  if (clean.value.exitCode !== 0) {
    return Result.error(
      new StorageError({
        subCode: 'io',
        message: `git clean -fd failed: ${(clean.value.stderr || clean.value.stdout).trim()}`,
      })
    );
  }
  return Result.ok(undefined);
};

/**
 * Read the short ref name of the current `HEAD`. Returns `'HEAD'` when detached — surfaced
 * verbatim so the caller can detect that case and produce a tailored error.
 */
export const gitGetCurrentBranch = async (
  runner: GitRunner,
  cwd: AbsolutePath
): Promise<Result<string, StorageError>> => {
  const result = await runner.run(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (!result.ok) return Result.error(result.error);
  if (result.value.exitCode !== 0) {
    return Result.error(
      new StorageError({
        subCode: 'io',
        message: `git rev-parse --abbrev-ref HEAD failed: ${(result.value.stderr || result.value.stdout).trim()}`,
      })
    );
  }
  const name = result.value.stdout.trim();
  if (name.length === 0) {
    return Result.error(new StorageError({ subCode: 'io', message: 'git rev-parse returned empty branch name' }));
  }
  return Result.ok(name);
};

/** True iff `refs/heads/<name>` exists locally. Non-zero exit from `show-ref --verify --quiet` is interpreted as "absent". */
export const gitBranchExists = async (
  runner: GitRunner,
  cwd: AbsolutePath,
  name: string
): Promise<Result<boolean, StorageError>> => {
  const result = await runner.run(cwd, ['show-ref', '--verify', '--quiet', `refs/heads/${name}`]);
  if (!result.ok) return Result.error(result.error);
  return Result.ok(result.value.exitCode === 0);
};

/**
 * Idempotent branch switch: no-op when already on `name`, fast-forward checkout when the branch
 * exists locally, otherwise create-and-switch via `checkout -b`. Mirrors v1 — the v1 design did
 * not pull from a remote first; the user owns "main is up to date" hygiene.
 */
export const gitCreateAndCheckoutBranch = async (
  runner: GitRunner,
  cwd: AbsolutePath,
  name: string
): Promise<Result<void, StorageError>> => {
  const current = await gitGetCurrentBranch(runner, cwd);
  if (!current.ok) return Result.error(current.error);
  if (current.value === name) return Result.ok(undefined);

  const exists = await gitBranchExists(runner, cwd, name);
  if (!exists.ok) return Result.error(exists.error);

  const argv = exists.value ? ['checkout', name] : ['checkout', '-b', name];
  const checkout = await runner.run(cwd, argv);
  if (!checkout.ok) return Result.error(checkout.error);
  if (checkout.value.exitCode !== 0) {
    return Result.error(
      new StorageError({
        subCode: 'io',
        message: `git checkout failed: ${(checkout.value.stderr || checkout.value.stdout).trim()}`,
      })
    );
  }
  return Result.ok(undefined);
};

const validateCommitMessage = (message: string): Result<string, StorageError> => {
  if (message.length === 0) {
    return Result.error(new StorageError({ subCode: 'io', message: 'commit message must not be empty' }));
  }
  const bytes = Buffer.byteLength(message, 'utf8');
  if (bytes > COMMIT_MESSAGE_MAX_BYTES) {
    return Result.error(
      new StorageError({
        subCode: 'io',
        message: `commit message exceeds ${String(COMMIT_MESSAGE_MAX_BYTES)}-byte limit (${String(bytes)} bytes)`,
      })
    );
  }
  return Result.ok(message);
};
