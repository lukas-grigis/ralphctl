import { Result } from '@src/domain/result.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { TaskId } from '@src/domain/value/id/task-id.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';
import { gitStashList, gitStashPop } from '@src/integration/io/git-operations.ts';
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
        // No prior quarantined block for this task — the common case (most attempts never blocked).
        if (!stashes.value.includes(message)) return Result.ok(undefined);

        const popped = await gitStashPop(deps.gitRunner, opts.cwd, message);
        if (!popped.ok) {
          log.warn('stash pop failed — retry will start from a clean tree (diff still recoverable)', {
            taskId: String(taskId),
            stashMessage: message,
            error: popped.error.message,
          });
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
