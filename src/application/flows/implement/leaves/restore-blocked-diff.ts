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
 * Restoration is a convenience, not a correctness requirement: a clean-tree retry is always valid
 * (the prior work is recoverable via `git stash list` regardless). So EVERY failure here — a stash
 * list failure, a pop conflict — is logged and swallowed as `Result.ok(undefined)`. The leaf writes
 * nothing to ctx. A missing stash is the common case (most attempts have no prior block to restore)
 * and is a silent no-op. `AbortError` stays the one exception: the leaf framework checks
 * `signal?.aborted` around the use case, so a mid-run cancel surfaces as an `aborted` trace entry
 * verbatim — this best-effort swallow only ever catches the `StorageError` a git call returns.
 *
 * Swallowing the failure is NOT the same as leaving the tree alone, though: a pop that CONFLICTS
 * has already written its half-merged result into the working tree. {@link undoConflictedPop}
 * undoes exactly that case before the leaf returns — see its docstring.
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
 * Paths left UNMERGED (conflicted) in the index — `git diff --name-only --diff-filter=U`; empty on
 * a tree with no conflict. A raw `gitRunner.run`, like `work-product-fingerprint.ts`'s own reads,
 * rather than a `git-operations.ts` export: that module sits exactly on its `max-lines` budget, and
 * this one-shot probe has a single caller. A non-zero exit surfaces as `Result.error` so "git is
 * broken in this tree" is never read as "no conflict".
 */
const unmergedPaths = async (runner: GitRunner, cwd: AbsolutePath): Promise<Result<string[], DomainError>> => {
  const result = await runner.run(cwd, ['diff', '--name-only', '--diff-filter=U']);
  if (!result.ok) return Result.error(result.error);
  if (result.value.exitCode !== 0) {
    return Result.error(
      new StorageError({
        subCode: 'io',
        message: `git diff --diff-filter=U failed: ${(result.value.stderr || result.value.stdout).trim()}`,
      })
    );
  }
  return Result.ok(result.value.stdout.split('\n').filter((line) => line.length > 0));
};

/**
 * Undo a CONFLICTED `git stash pop`. A non-zero pop is not a no-op: on a content conflict git
 * applies the merge and leaves the `<<<<<<<`-marked result in the working tree while KEEPING the
 * stash entry. Returning from there without touching the tree — what this leaf used to do, under a
 * log line promising a clean tree — hands `pre-task-verify` a red baseline it charges to
 * `baseline-broken` (so no block is set) and lets `commit-task`'s `git add -A` land conflict
 * markers in a real commit. The conflict is likely by construction: the stash was pushed against
 * the PRIOR attempt's tree and pops into one forked from a since-advanced sprint branch.
 *
 * So probe for unmerged paths and, when the pop really did conflict, reset the tree to HEAD —
 * `gitResetHard` is `reset --hard HEAD` + `clean -fd`, and the clean is what it takes to also drop
 * the untracked files a `-u` stash restores; ignored paths (`node_modules`, build caches) survive,
 * so a prepared worktree stays prepared. HEAD is the pre-pop state HERE because this leaf runs at
 * the start of an attempt on a tree the quarantine step already emptied; `git stash pop` will
 * happily apply onto unrelated uncommitted changes and conflict on the stashed paths alone, and any
 * such work would be discarded along with the half-merge. Nothing the POP brought in is lost: git
 * keeps the stash entry on a conflicted pop, which is exactly what makes the reset safe — the diff
 * stays recoverable by hand under the same message.
 *
 * A pop that failed WITHOUT leaving unmerged paths (git refusing before it applied anything, e.g.
 * 'local changes would be overwritten') left the tree exactly as this leaf found it, so resetting
 * there would destroy work this leaf never put at risk. Hence the probe gate rather than a blind
 * reset — and, when the probe itself fails, no reset either: the tree state is then unknown and
 * `reset --hard` is the more destructive guess.
 */
const undoConflictedPop = async (
  runner: GitRunner,
  cwd: AbsolutePath,
  log: Logger,
  taskId: TaskId,
  message: string,
  popError: string
): Promise<void> => {
  const unmerged = await unmergedPaths(runner, cwd);
  if (!unmerged.ok) {
    log.warn('stash pop failed and the conflict probe failed — tree state unverified, diff still in the stash', {
      taskId: String(taskId),
      stashMessage: message,
      error: popError,
      probeError: unmerged.error.message,
    });
    return;
  }
  if (unmerged.value.length === 0) {
    log.warn('stash pop failed before applying anything — retry starts from the unchanged tree', {
      taskId: String(taskId),
      stashMessage: message,
      error: popError,
    });
    return;
  }
  const reset = await gitResetHard(runner, cwd);
  if (!reset.ok) {
    log.warn('stash pop conflicted and the tree reset failed — the tree may still hold conflict markers', {
      taskId: String(taskId),
      stashMessage: message,
      conflictedPaths: unmerged.value.length,
      error: reset.error.message,
    });
    return;
  }
  log.warn('stash pop conflicted; tree reset, diff still in stash', {
    taskId: String(taskId),
    stashMessage: message,
    conflictedPaths: unmerged.value.length,
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

        const popped = await gitStashPop(deps.gitRunner, opts.cwd, message);
        if (!popped.ok) {
          // Best-effort, but never silent about the tree: a conflicted pop is undone before the
          // retry proceeds (see `undoConflictedPop`), and each outcome logs what actually happened.
          await undoConflictedPop(deps.gitRunner, opts.cwd, log, taskId, message, popped.error.message);
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
