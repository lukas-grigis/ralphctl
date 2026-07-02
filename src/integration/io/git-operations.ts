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
// No byte cap on commit messages: audit-[03] mandates "no caps anywhere" on AI signal
// bodies, and `git commit -m <msg>` passes via argv which has ARG_MAX headroom in the
// hundreds of KB. The AI's validated `commit-message` signal is projected verbatim onto
// the commit; the harness only appends the deterministic `Closes …` trailer when a task
// carries external refs.

export interface GitStatusEntry {
  readonly status: string;
  readonly path: string;
}

/**
 * Result of {@link gitCommitWithMessage}. Discriminated on `committed` so `headSha` is only
 * reachable on the success arm — mirrors the business-layer `CommitResult` shape the commit-task
 * leaf bridges to, keeping the "no commit → no SHA" invariant compiler-enforced on both sides.
 */
export type CommitOutcome = { readonly committed: true; readonly headSha: string } | { readonly committed: false };

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

/**
 * The set of working-tree paths that differ from `HEAD` — the attempt's diff footprint. Used by
 * post-task-verify to scope which structured verify gates run (only gates whose `pathPrefix`
 * matches a changed path). Combines `git diff --name-only HEAD` (tracked, staged + unstaged) with
 * `git ls-files --others --exclude-standard` (untracked but not ignored) so a brand-new file in a
 * module still scopes that module's gate in.
 *
 * Returns POSIX-style, repo-root-relative paths (git emits these natively). Bubbles a
 * `StorageError` on any non-zero git exit so the caller can apply its run-ALL-gates fallback —
 * never silently returns an empty footprint on a git failure.
 */
export const gitDiffFootprint = async (
  runner: GitRunner,
  cwd: AbsolutePath
): Promise<Result<readonly string[], StorageError>> => {
  const diff = await runner.run(cwd, ['diff', '--name-only', 'HEAD']);
  if (!diff.ok) return Result.error(diff.error);
  if (diff.value.exitCode !== 0) {
    return Result.error(
      new StorageError({
        subCode: 'io',
        message: `git diff --name-only HEAD failed: ${(diff.value.stderr || diff.value.stdout).trim()}`,
      })
    );
  }
  const untracked = await runner.run(cwd, ['ls-files', '--others', '--exclude-standard']);
  if (!untracked.ok) return Result.error(untracked.error);
  if (untracked.value.exitCode !== 0) {
    return Result.error(
      new StorageError({
        subCode: 'io',
        message: `git ls-files --others failed: ${(untracked.value.stderr || untracked.value.stdout).trim()}`,
      })
    );
  }
  const paths = new Set<string>();
  for (const line of `${diff.value.stdout}\n${untracked.value.stdout}`.split('\n')) {
    const path = line.trim();
    if (path.length > 0) paths.add(path);
  }
  return Result.ok([...paths]);
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
 * preserved verbatim. Length is enforced at <=500 UTF-8 bytes — git itself accepts more,
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

/**
 * List stash entry subjects in the same order as `git stash list`. An empty stash yields
 * `Result.ok([])`. Bubbles a non-zero exit (e.g. not a git repo) as StorageError so callers
 * don't mistake a transport failure for an empty stash.
 */
export const gitStashList = async (runner: GitRunner, cwd: AbsolutePath): Promise<Result<string[], StorageError>> => {
  const result = await runner.run(cwd, ['stash', 'list', '--format=%s']);
  if (!result.ok) return Result.error(result.error);
  if (result.value.exitCode !== 0) {
    return Result.error(
      new StorageError({
        subCode: 'io',
        message: `git stash list failed: ${(result.value.stderr || result.value.stdout).trim()}`,
      })
    );
  }
  return Result.ok(result.value.stdout.split('\n').filter((line) => line.length > 0));
};

/**
 * Pop the first stash entry whose subject matches `message` exactly. Returns
 * `{ popped: false }` (a no-op) when no entry matches — callers treat a missing stash as
 * "nothing to restore", not an error.
 */
export const gitStashPop = async (
  runner: GitRunner,
  cwd: AbsolutePath,
  message: string
): Promise<Result<{ readonly popped: boolean }, StorageError>> => {
  const list = await gitStashList(runner, cwd);
  if (!list.ok) return Result.error(list.error);

  const index = list.value.findIndex((entry) => entry === message);
  if (index === -1) return Result.ok({ popped: false });

  const pop = await runner.run(cwd, ['stash', 'pop', `stash@{${String(index)}}`]);
  if (!pop.ok) return Result.error(pop.error);
  if (pop.value.exitCode !== 0) {
    return Result.error(
      new StorageError({
        subCode: 'io',
        message: `git stash pop failed: ${(pop.value.stderr || pop.value.stdout).trim()}`,
      })
    );
  }
  return Result.ok({ popped: true });
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

// `git worktree add` can be slow: it materialises a full checkout (and may need to populate the
// index from a large tree). The default 30s runner ceiling is comfortable for status / commit /
// rev-parse but tight for a fresh worktree on a big repo, so add gets a roomier budget. The other
// worktree verbs (remove / prune / fold) are bounded by index work, not a full checkout, and keep
// the runner default.
const WORKTREE_ADD_TIMEOUT_MS = 120_000;

/**
 * Canonical worktree branch ref for one parallel task: `ralphctl/<sprintId>/wt-<taskId>`.
 *
 * One nesting level below the shared sprint branch (`ralphctl/<sprintId>`) so the whole sprint's
 * worktree refs share a prefix and prune cleanly. Pure — no validation here; sprint / task ids are
 * UUID-shaped upstream, so the result is always a valid git ref name.
 */
export const gitWorktreeRef = (sprintId: string, taskId: string): string => `ralphctl/${sprintId}/wt-${taskId}`;

/**
 * Create a new worktree at `worktreePath` checked out on a freshly-created branch `branchName`,
 * forked from the current `HEAD` of `repoRoot` (the shared sprint branch). `git worktree add -b
 * <branch> <path>` — the `-b` form fails loudly if the branch already exists, which is the
 * behaviour we want: a stale ref from a crashed prior run must be pruned first, never silently
 * reused.
 *
 * Roomier timeout than the runner default — a fresh checkout can outlast 30s on a large repo.
 */
export const gitWorktreeAdd = async (
  runner: GitRunner,
  repoRoot: AbsolutePath,
  worktreePath: AbsolutePath,
  branchName: string
): Promise<Result<void, StorageError>> => {
  const result = await runner.run(repoRoot, ['worktree', 'add', '-b', branchName, String(worktreePath)], {
    timeoutMs: WORKTREE_ADD_TIMEOUT_MS,
  });
  if (!result.ok) return Result.error(result.error);
  if (result.value.exitCode !== 0) {
    return Result.error(
      new StorageError({
        subCode: 'io',
        message: `git worktree add failed: ${(result.value.stderr || result.value.stdout).trim()}`,
      })
    );
  }
  return Result.ok(undefined);
};

/**
 * Remove the worktree rooted at `worktreePath` with `--force` — drops the checkout even when the
 * worktree has uncommitted or untracked changes. Used on every exit path (success, abort, fatal)
 * so a dead worktree never strands the sprint repo. `--force` is deliberate: the worktree's
 * commits have already been folded onto the sprint branch by the time we remove it, so anything
 * left in the working tree is scratch.
 */
export const gitWorktreeRemove = async (
  runner: GitRunner,
  repoRoot: AbsolutePath,
  worktreePath: AbsolutePath
): Promise<Result<void, StorageError>> => {
  const result = await runner.run(repoRoot, ['worktree', 'remove', '--force', String(worktreePath)]);
  if (!result.ok) return Result.error(result.error);
  if (result.value.exitCode !== 0) {
    return Result.error(
      new StorageError({
        subCode: 'io',
        message: `git worktree remove failed: ${(result.value.stderr || result.value.stdout).trim()}`,
      })
    );
  }
  return Result.ok(undefined);
};

/**
 * Force-delete a local branch ref (`git branch -D <name>`). Used to drop the throwaway
 * `ralphctl/<sprint>/wt-<task>` ref a worktree was created on: `git worktree remove` deletes the
 * worktree directory and its `.git/worktrees/<name>` record but LEAVES the branch behind, so a
 * later `worktree add -b <same-ref>` (e.g. on relaunch after an aborted task) would otherwise fail
 * with "branch already exists". `gitWorktreePrune` does not cover this — it only touches worktree
 * records, not orphaned refs.
 */
export const gitDeleteBranch = async (
  runner: GitRunner,
  cwd: AbsolutePath,
  branchName: string
): Promise<Result<void, StorageError>> => {
  const result = await runner.run(cwd, ['branch', '-D', branchName]);
  if (!result.ok) return Result.error(result.error);
  if (result.value.exitCode !== 0) {
    return Result.error(
      new StorageError({
        subCode: 'io',
        message: `git branch -D failed: ${(result.value.stderr || result.value.stdout).trim()}`,
      })
    );
  }
  return Result.ok(undefined);
};

/**
 * Prune worktree administrative bookkeeping for worktrees whose directory has already vanished.
 * `git worktree prune` is idempotent and cheap — it only touches `.git/worktrees/<name>` records,
 * the same pointer-file machinery `git-exclude.ts` resolves through. Safe to call defensively
 * before re-adding a worktree whose path was deleted out from under git.
 */
export const gitWorktreePrune = async (
  runner: GitRunner,
  repoRoot: AbsolutePath
): Promise<Result<void, StorageError>> => {
  const result = await runner.run(repoRoot, ['worktree', 'prune']);
  if (!result.ok) return Result.error(result.error);
  if (result.value.exitCode !== 0) {
    return Result.error(
      new StorageError({
        subCode: 'io',
        message: `git worktree prune failed: ${(result.value.stderr || result.value.stdout).trim()}`,
      })
    );
  }
  return Result.ok(undefined);
};

/**
 * Fold a worktree branch onto the current branch of `repoRoot` (the shared sprint branch),
 * preserving linear history so the sprint lands as one branch → one PR.
 *
 *   1. `git merge --ff-only <branch>` — the common case: the worktree forked from the sprint tip
 *      and no sibling has folded since, so a fast-forward moves the sprint branch pointer with no
 *      new commit. Linear by construction.
 *   2. On ff failure (a sibling folded first, so the sprint branch has advanced), cherry-pick the
 *      commits unique to `<branch>` — `git cherry-pick <merge-base>..<branch>` — replaying them on
 *      top of the now-advanced sprint branch. Still linear; still one branch.
 *
 * A cherry-pick conflict SURFACES AS AN ERROR (the caller maps it to task `blocked`). Before
 * returning the error we `git cherry-pick --abort` so the sprint branch is left clean and the
 * already-folded siblings stay landed — the conflicted task is the only casualty.
 *
 * Folds must be serialised by the caller (one held lock, `base.tasks` order); this function does
 * not lock — concurrent folds onto the same branch would corrupt the merge state.
 */
export const gitFoldBranch = async (
  runner: GitRunner,
  repoRoot: AbsolutePath,
  branchName: string
): Promise<Result<void, StorageError>> => {
  const ff = await runner.run(repoRoot, ['merge', '--ff-only', branchName]);
  if (!ff.ok) return Result.error(ff.error);
  if (ff.value.exitCode === 0) return Result.ok(undefined);

  // Not fast-forwardable — the sprint branch advanced under us. Replay the branch's unique
  // commits via cherry-pick of `<merge-base>..<branch>`.
  const base = await runner.run(repoRoot, ['merge-base', 'HEAD', branchName]);
  if (!base.ok) return Result.error(base.error);
  if (base.value.exitCode !== 0) {
    return Result.error(
      new StorageError({
        subCode: 'io',
        message: `git merge-base failed: ${(base.value.stderr || base.value.stdout).trim()}`,
      })
    );
  }
  const mergeBase = base.value.stdout.trim();
  if (!HEX_SHA_RE.test(mergeBase)) {
    return Result.error(
      new StorageError({ subCode: 'io', message: `git merge-base returned non-SHA output: '${mergeBase}'` })
    );
  }

  const pick = await runner.run(repoRoot, ['cherry-pick', `${mergeBase}..${branchName}`]);
  if (!pick.ok) return Result.error(pick.error);
  if (pick.value.exitCode !== 0) {
    // Conflict (or any cherry-pick failure). Abort so the sprint branch is left clean — folded
    // siblings stay landed; only this task is blocked. Abort is best-effort: surface the original
    // cherry-pick failure regardless of whether the abort itself errored.
    await runner.run(repoRoot, ['cherry-pick', '--abort']);
    return Result.error(
      new StorageError({
        subCode: 'io',
        message: `git cherry-pick failed (conflict folding ${branchName}): ${(pick.value.stderr || pick.value.stdout).trim()}`,
      })
    );
  }
  return Result.ok(undefined);
};

const validateCommitMessage = (message: string): Result<string, StorageError> => {
  if (message.length === 0) {
    return Result.error(new StorageError({ subCode: 'io', message: 'commit message must not be empty' }));
  }
  return Result.ok(message);
};
