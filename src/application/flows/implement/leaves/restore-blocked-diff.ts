import { Result } from '@src/domain/result.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { TaskId } from '@src/domain/value/id/task-id.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';
import {
  gitResetHard,
  gitStashList,
  gitStashPop,
  stashEntryMatchesMessage,
} from '@src/integration/io/git-operations.ts';
import type { GitRunner } from '@src/integration/io/git-runner.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';
import { quarantineStashMessage } from '@src/application/flows/implement/leaves/quarantine-blocked-diff.ts';

/**
 * Restore a previously quarantined blocked diff at the START of each attempt so the generator
 * continues from prior AI work instead of starting from a clean tree.
 *
 * ## What this undoes
 *
 * When a task settles `blocked`, `quarantine-blocked-diff` stashes the AI's rejected diff under the
 * deterministic message `quarantineStashMessage(sprintId, taskId)` so the shared serial worktree is
 * clean for the next task. On a later retry of that same task there was nothing to resurrect that
 * work — the generator restarted from scratch, throwing away whatever the prior attempt produced.
 * This leaf pops that exact stash back into the tree before the generator runs, so the retry builds
 * on the prior diff plus the evaluator critique rather than from zero.
 *
 * ## Best-effort by design
 *
 * Restoration is a convenience, not a correctness requirement: a retry that starts without the prior
 * diff is always valid (that work stays recoverable via `git stash list` regardless). So EVERY
 * failure here — a stash list failure, a pop conflict — is logged and swallowed as
 * `Result.ok(undefined)`. The leaf writes nothing to ctx. A missing stash is the common case (most
 * attempts have no prior block to restore) and is a silent no-op that costs one git call.
 * `AbortError` stays the one exception: the leaf framework checks `signal?.aborted` around the use
 * case, so a mid-run cancel surfaces as an `aborted` trace entry verbatim — this best-effort swallow
 * only ever catches the `StorageError` a git call returns.
 *
 * ## Only onto a clean tree
 *
 * Swallowing a failed pop is NOT the same as leaving the tree alone: git can change the tree and
 * still fail, so {@link undoFailedPop} resets it before the leaf returns. That reset can only be
 * limited to what the pop brought in if nothing else was in the tree, so the leaf pops ONLY onto a
 * tree it just probed clean. A tree can legitimately be dirty here: changes the operator chose to
 * keep at the preflight prompt, the failing test the per-task reproduce step writes before the first
 * attempt, or a setup script's output that isn't ignored. None of that work sits in any stash. On a
 * dirty tree, or when the probe fails, the leaf leaves the quarantined diff where it is and logs its
 * message, and the retry starts from the tree as found. Popping anyway is not an option: git will
 * happily apply a stash onto unrelated changes and conflict on its own paths, and no undo could then
 * separate the half-merge from the work that was already there.
 */
export interface RestoreBlockedDiffLeafDeps {
  readonly gitRunner: GitRunner;
  readonly logger: Logger;
}

export interface RestoreBlockedDiffLeafOpts {
  /** The tree the retry runs against — where the prior blocked diff is restored. */
  readonly cwd: AbsolutePath;
}

interface RestoreBlockedDiffInput {
  readonly sprintId: SprintId;
}

/**
 * Porcelain lines for everything `reset --hard HEAD` + `clean -fd` could touch: staged, unstaged and
 * unmerged changes plus untracked files. An empty list means that undo has nothing of the tree's own
 * to destroy. Two flags override repo config that a plain `gitStatusPorcelain` inherits, and that
 * would otherwise make a tree look cleaner than the undo treats it: `--untracked-files=normal` beats
 * `status.showUntrackedFiles=no` (hidden untracked files are still deleted by `clean -fd`), and
 * `--ignore-submodules=none` beats a `submodule.<name>.ignore` setting.
 *
 * A raw `gitRunner.run`, like `work-product-fingerprint.ts`'s own reads, rather than a
 * `git-operations.ts` export: that module sits at its `max-lines` budget, and this probe's config
 * overrides are specific to guarding this undo. A non-zero exit surfaces as `Result.error` so "git
 * is broken in this tree" is never read as "clean".
 */
const treeChanges = async (runner: GitRunner, cwd: AbsolutePath): Promise<Result<string[], DomainError>> => {
  const result = await runner.run(cwd, [
    'status',
    '--porcelain',
    '--untracked-files=normal',
    '--ignore-submodules=none',
  ]);
  if (!result.ok) return Result.error(result.error);
  if (result.value.exitCode !== 0) {
    return Result.error(
      new StorageError({
        subCode: 'io',
        message: `git status failed: ${(result.value.stderr || result.value.stdout).trim()}`,
      })
    );
  }
  return Result.ok(result.value.stdout.split('\n').filter((line) => line.length > 0));
};

/**
 * Undo a FAILED `git stash pop`. A non-zero pop is not a no-op. On a content conflict git leaves the
 * `<<<<<<<`-marked merge in the working tree, and even a pop git reports as refused can apply part
 * of the stash first: an untracked-file collision still lands the tracked changes, and an
 * "overwritten" refusal still restores the untracked files. Either way git KEEPS the stash entry.
 * Returning from there without touching the tree hands `pre-task-verify` a red baseline it charges
 * to `baseline-broken` (so no block is set), and lets `commit-task`'s `git add -A` commit conflict
 * markers or half of the prior diff. A conflict is likely by construction: the stash was pushed
 * against the PRIOR attempt's tree and pops into one forked from a since-advanced sprint branch.
 *
 * The caller only pops onto a tree it probed clean a moment earlier, so any change the probe finds
 * now came from the pop. Nothing else writes to this tree meanwhile: the serial path runs one task
 * at a time, and each parallel worktree belongs to one task. `gitResetHard` (`reset --hard HEAD` +
 * `clean -fd`) is then an exact undo that can't reach work this leaf didn't put there. The clean
 * also drops the untracked files a `-u` stash restores. Ignored paths (`node_modules`, build caches)
 * are outside both commands, so a prepared worktree stays prepared. Nothing the pop brought in is
 * lost either: the stash entry is still there under the same message.
 *
 * A tree the probe finds clean needs no undo. When the probe itself fails there's no reset either:
 * the tree state is then unknown, and `reset --hard` is the more destructive guess.
 */
const undoFailedPop = async (
  runner: GitRunner,
  cwd: AbsolutePath,
  log: Logger,
  taskId: TaskId,
  message: string,
  popError: string
): Promise<void> => {
  const changed = await treeChanges(runner, cwd);
  if (!changed.ok) {
    log.warn('stash pop failed and the tree probe failed — tree state unverified, diff still in the stash', {
      taskId: String(taskId),
      stashMessage: message,
      error: popError,
      probeError: changed.error.message,
    });
    return;
  }
  if (changed.value.length === 0) {
    log.warn('stash pop failed without changing the tree — retry starts from the unchanged tree', {
      taskId: String(taskId),
      stashMessage: message,
      error: popError,
    });
    return;
  }
  const reset = await gitResetHard(runner, cwd);
  if (!reset.ok) {
    log.warn('stash pop failed and the tree reset failed — the tree may still hold what the pop applied', {
      taskId: String(taskId),
      stashMessage: message,
      changedPaths: changed.value.length,
      error: reset.error.message,
    });
    return;
  }
  log.warn('stash pop failed; tree reset to its clean pre-pop state, diff still in stash', {
    taskId: String(taskId),
    stashMessage: message,
    changedPaths: changed.value.length,
    error: popError,
  });
};

export const restoreBlockedDiffLeaf = (
  deps: RestoreBlockedDiffLeafDeps,
  opts: RestoreBlockedDiffLeafOpts,
  taskId: TaskId
): Element<ImplementCtx> =>
  leaf<ImplementCtx, RestoreBlockedDiffInput, undefined>(`restore-blocked-diff-${String(taskId)}`, {
    useCase: {
      execute: async (input): Promise<Result<undefined, DomainError>> => {
        const log = deps.logger.named('task.restore-blocked-diff');
        const message = quarantineStashMessage(input.sprintId, taskId);

        const stashes = await gitStashList(deps.gitRunner, opts.cwd);
        if (!stashes.ok) {
          log.warn('stash list failed — retry will start from a clean tree', {
            taskId: String(taskId),
            cwd: String(opts.cwd),
            error: stashes.error.message,
          });
          return Result.ok(undefined);
        }
        // No prior quarantined block for this task — the common case (most attempts never
        // blocked). Matched via `stashEntryMatchesMessage` — real git renders the subject
        // `On <branch>: <message>`, never the bare message, so an exact-equality check here
        // would never match a real stash and this pre-check would always (wrongly) short-circuit.
        if (!stashes.value.some((entry) => stashEntryMatchesMessage(entry, message))) return Result.ok(undefined);

        // Pop only onto a clean tree — the undo of a failed pop can't separate the pop's changes from
        // work that was already here (see "Only onto a clean tree" above).
        const before = await treeChanges(deps.gitRunner, opts.cwd);
        if (!before.ok) {
          log.warn('tree probe failed — prior blocked diff left in the stash, retry starts without it', {
            taskId: String(taskId),
            cwd: String(opts.cwd),
            stashMessage: message,
            error: before.error.message,
          });
          return Result.ok(undefined);
        }
        if (before.value.length > 0) {
          log.warn('tree has uncommitted changes — prior blocked diff left in the stash, retry starts without it', {
            taskId: String(taskId),
            cwd: String(opts.cwd),
            stashMessage: message,
            uncommittedPaths: before.value.length,
          });
          return Result.ok(undefined);
        }

        const popped = await gitStashPop(deps.gitRunner, opts.cwd, message);
        if (!popped.ok) {
          // Best-effort, but never silent about the tree: whatever a failed pop applied is undone
          // before the retry proceeds (see `undoFailedPop`), and each outcome logs what happened.
          await undoFailedPop(deps.gitRunner, opts.cwd, log, taskId, message, popped.error.message);
          return Result.ok(undefined);
        }
        if (popped.value.popped) {
          log.info('prior blocked diff restored from stash', {
            taskId: String(taskId),
            stashMessage: message,
          });
        }
        return Result.ok(undefined);
      },
    },
    input: (ctx): RestoreBlockedDiffInput => ({ sprintId: ctx.sprintId }),
    output: (ctx) => ctx,
  });
