import { Result } from '@src/domain/result.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { TaskId } from '@src/domain/value/id/task-id.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import { renderRescueBreadcrumb } from '@src/business/sprint/journal-structure.ts';
import { gitBranchExists, gitDeleteBranch } from '@src/integration/io/git-operations.ts';
import { gitRenameBranch, gitRescueRef, gitUniqueCommitCount } from '@src/integration/io/git-ref-rescue.ts';

import type { BuildWaveBranchesDeps } from '@src/application/flows/implement/wave-branch.ts';

/** The task whose worktree is about to be created, and where its recovery pointer is journaled. */
export interface StaleRefTarget {
  readonly repoRoot: AbsolutePath;
  readonly sprintId: SprintId;
  readonly taskId: TaskId;
  readonly taskName: string;
  readonly progressFile: AbsolutePath;
}

// A second rescue of the same task within one second (current + legacy ref) needs a distinct name.
const MAX_RESCUE_SUFFIX = 9;

/**
 * Clear every ref an earlier run of this task left behind (`refs`: the current and the legacy
 * shape) so `worktree add -b` can create a fresh one. A ref whose commits the sprint branch (`HEAD`
 * of `repoRoot`) already has is deleted; one holding commits it lacks — a fold that conflicted or
 * never ran — is moved under `ralphctl-rescue/` instead, because deleting it would leave that
 * verified work reachable only through the reflog. A ref some worktree still has checked out is
 * skipped: that worktree may be adopted, and git refuses to delete it anyway.
 *
 * Fails only when a ref's unlanded commits can't be confirmed absent or can't be moved aside — the
 * caller then fails the worktree setup, leaving the task untouched rather than risking the work.
 */
export const settleStaleWorktreeRefs = async (
  deps: BuildWaveBranchesDeps,
  target: StaleRefTarget,
  refs: readonly string[],
  checkedOut: ReadonlySet<string>
): Promise<Result<void, StorageError>> => {
  for (const ref of new Set(refs)) {
    if (checkedOut.has(`refs/heads/${ref}`)) continue;
    const settled = await settleOneRef(deps, target, ref);
    if (!settled.ok) return settled;
  }
  return Result.ok(undefined);
};

const settleOneRef = async (
  deps: BuildWaveBranchesDeps,
  target: StaleRefTarget,
  ref: string
): Promise<Result<void, StorageError>> => {
  const { gitRunner } = deps.implement;
  const exists = await gitBranchExists(gitRunner, target.repoRoot, ref);
  if (!exists.ok) return Result.error(exists.error);
  if (!exists.value) return Result.ok(undefined);
  const unique = await gitUniqueCommitCount(gitRunner, target.repoRoot, 'HEAD', ref);
  if (!unique.ok) {
    return Result.error(
      new StorageError({
        subCode: 'io',
        message: `could not check ${ref} for unlanded commits — inspect it, then relaunch: ${unique.error.message}`,
        cause: unique.error,
      })
    );
  }
  if (unique.value === 0) {
    // Best-effort like before: a ref that refuses deletion makes the `worktree add` fail loudly.
    await gitDeleteBranch(gitRunner, target.repoRoot, ref);
    return Result.ok(undefined);
  }
  return rescueRef(deps, target, ref, unique.value);
};

const freeRescueRef = async (deps: BuildWaveBranchesDeps, target: StaleRefTarget): Promise<string> => {
  const base = gitRescueRef(String(target.sprintId), String(target.taskId), deps.implement.clock());
  for (let n = 1; n <= MAX_RESCUE_SUFFIX; n++) {
    const candidate = n === 1 ? base : `${base}-${String(n)}`;
    const taken = await gitBranchExists(deps.implement.gitRunner, target.repoRoot, candidate);
    if (!taken.ok || !taken.value) return candidate;
  }
  // Every candidate taken: the rename below fails (`branch -m` never overwrites) and setup fails safe.
  return base;
};

const rescueRef = async (
  deps: BuildWaveBranchesDeps,
  target: StaleRefTarget,
  ref: string,
  commits: number
): Promise<Result<void, StorageError>> => {
  const { gitRunner, logger, clock, appendFile, journalMutex } = deps.implement;
  const to = await freeRescueRef(deps, target);
  const renamed = await gitRenameBranch(gitRunner, target.repoRoot, ref, to);
  if (!renamed.ok) {
    return Result.error(
      new StorageError({
        subCode: 'io',
        message: `could not move aside ${ref} holding ${String(commits)} unlanded commit(s) — rename or delete it by hand, then relaunch`,
        cause: renamed.error,
      })
    );
  }
  const taskId = String(target.taskId);
  logger.warn('worktree ref held unlanded commits — moved aside instead of deleted', {
    taskId,
    ref,
    rescueRef: to,
    commits,
  });
  deps.eventBus.publish({
    type: 'banner-show',
    id: `ref-rescued-${taskId}`,
    tier: 'warn',
    message: `kept ${String(commits)} unlanded commit(s) of "${target.taskName}" as ${to} — cherry-pick to recover`,
    at: clock(),
  });
  // Under the journal mutex: a sibling branch may be mid read-modify-write of the same progress.md.
  const line = renderRescueBreadcrumb(target.taskName, commits, ref, to);
  const appended = await journalMutex.run(() => appendFile(target.progressFile, line));
  if (!appended.ok) {
    logger.warn('rescue pointer journal append failed', { taskId, rescueRef: to, error: appended.error.message });
  }
  return Result.ok(undefined);
};
