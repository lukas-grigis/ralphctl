import { Result } from '@src/domain/result.ts';
import { type RecordQuarantineOutput, recordQuarantineUseCase } from '@src/business/task/record-quarantine.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { BlockedTask } from '@src/domain/entity/task.ts';
import type { TaskId } from '@src/domain/value/id/task-id.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { UpdateTask } from '@src/domain/repository/task/update-task.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';
import { gitStashPush } from '@src/integration/io/git-operations.ts';
import type { GitRunner } from '@src/integration/io/git-runner.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';

/**
 * Quarantine the rejected working-tree diff of a task that just settled `blocked` on the SERIAL
 * implement path — so the shared sprint worktree is clean again before the next task's sub-chain
 * runs.
 *
 * ## The bug this closes
 *
 * `settle-attempt`'s dirty-tree guardrail DELIBERATELY exempts the block path: a self-blocked task
 * leaves its rejected diff in place so the operator (or a future attempt) can inspect it. That is
 * safe in a per-task git WORKTREE (the parallel path — each task is isolated), but the serial path
 * runs every task in ONE shared tree. Nothing cleaned the tree between tasks, so:
 *
 *  1. the next task's `git add -A` commit swept task A's rejected diff into task B's commit;
 *  2. A's leftovers flipped B's pre-verify red, B's red post-verify was attributed `baseline-broken`
 *     (no block set) and the corrupt commit landed even on a red tree;
 *  3. the evaluator's primary input (the uncommitted working-tree diff) was equally contaminated.
 *
 * Stashing A's diff (untracked included, via `-u`) restores the invariant the prologue's one-shot
 * preflight assumes: between tasks the tree is clean.
 *
 * ## Placement & guard
 *
 * Spliced AFTER the attempt loop, BEFORE the terminal `uninstall-skills` leaf, so the terminal leaf
 * stays the subchain's last element (the TUI's task-completion detector keys on it). Gated by a
 * SYNCHRONOUS chain guard at the call site: it runs only when the settled task (read from
 * `ctx.tasks` — `settle-attempt` clears `ctx.currentTask`) is `blocked`, and only on the serial
 * path (the call site gates the splice on `includeBranchPreflight === true`). The guard does NOT
 * probe the tree — the leaf's own `gitStashPush` no-ops on a clean tree, so the dirty-tree check is
 * an effect of the operation, not a precondition.
 *
 * Upstream-blocked dependents never reach here (the dependency gate + body guard skip the whole
 * subchain body), so a dependency block can't trigger a spurious stash. The escalation-retry path
 * keeps the task `in_progress` (not `blocked`), so the guard skips it too.
 *
 * ## Best-effort by design
 *
 * Quarantine is cleanup that runs AFTER the block already settled and persisted. A git failure here
 * must NOT abort the run — the block is real regardless, and aborting would strand every later task.
 * So a stash / record failure is logged and the leaf returns `Result.ok`. `AbortError` stays the one
 * exception: the leaf framework checks `signal?.aborted` around the use case, so a mid-run cancel
 * surfaces as an `aborted` trace entry verbatim — this best-effort swallow only ever catches the
 * `StorageError` a git call returns, never an abort.
 */
export interface QuarantineBlockedDiffLeafDeps {
  readonly gitRunner: GitRunner;
  readonly taskRepo: UpdateTask;
  readonly logger: Logger;
}

export interface QuarantineBlockedDiffLeafOpts {
  /** The shared sprint worktree the just-blocked task ran (and dirtied) against. */
  readonly cwd: AbsolutePath;
}

interface QuarantineInput {
  readonly task: BlockedTask;
  readonly sprintId: SprintId;
}

/**
 * Deterministic stash message for one quarantined block — the recovery handle the operator greps
 * for in `git stash list`. Stable across runs (no timestamp / positional ref), so a relaunch that
 * re-quarantines produces an identical message and `record-quarantine` stays idempotent.
 *
 * @public
 */
export const quarantineStashMessage = (sprintId: SprintId, taskId: TaskId): string =>
  `ralphctl/${String(sprintId)}/${String(taskId)}/blocked-diff`;

export const quarantineBlockedDiffLeaf = (
  deps: QuarantineBlockedDiffLeafDeps,
  opts: QuarantineBlockedDiffLeafOpts,
  taskId: TaskId
): Element<ImplementCtx> =>
  leaf<ImplementCtx, QuarantineInput, RecordQuarantineOutput | undefined>(`quarantine-blocked-diff-${String(taskId)}`, {
    useCase: {
      execute: async (input): Promise<Result<RecordQuarantineOutput | undefined, DomainError>> => {
        const log = deps.logger.named('task.quarantine-blocked-diff');
        const message = quarantineStashMessage(input.sprintId, taskId);

        const stashed = await gitStashPush(deps.gitRunner, opts.cwd, message);
        if (!stashed.ok) {
          // Best-effort: the block already settled + persisted. A failed stash must not abort the
          // run (that would strand every later task); log and proceed leaving the tree as-is. The
          // next task's preflight clean-check / commit still surfaces a genuinely-dirty tree.
          log.warn('quarantine stash failed — proceeding without cleaning the tree', {
            taskId: String(taskId),
            cwd: String(opts.cwd),
            error: stashed.error.message,
          });
          return Result.ok(undefined);
        }
        // Clean tree → nothing to quarantine. The leaf is a no-op (no repo write); the next task
        // inherits a clean tree exactly as the prologue's one-shot preflight assumes.
        if (!stashed.value.stashed) return Result.ok(undefined);

        const recorded = await recordQuarantineUseCase({
          task: input.task,
          sprintId: input.sprintId,
          stashMessage: message,
          taskRepo: deps.taskRepo,
          logger: deps.logger,
        });
        if (!recorded.ok) {
          // The diff IS safely stashed; only the pointer-write failed. Still best-effort — log the
          // recovery message so the stash isn't lost to the operator even without the persisted line.
          log.warn('quarantine stash succeeded but recording the pointer failed', {
            taskId: String(taskId),
            stashMessage: message,
            error: recorded.error.message,
          });
          return Result.ok(undefined);
        }
        return Result.ok(recorded.value);
      },
    },
    input: (ctx): QuarantineInput => {
      const task = ctx.tasks?.find((t) => t.id === taskId);
      // The guard already asserted this task is `blocked`; a mismatch here is a ctx-shape bug
      // (programmer error) — surface it as a failed trace entry rather than stashing blindly.
      if (task === undefined || task.status !== 'blocked') {
        throw new InvalidStateError({
          entity: 'chain',
          currentState: task === undefined ? 'missing' : task.status,
          attemptedAction: `quarantine-blocked-diff-${String(taskId)}`,
          message: `quarantine-blocked-diff-${String(taskId)}: expected a settled blocked task on ctx.tasks`,
        });
      }
      return { task, sprintId: ctx.sprintId };
    },
    output: (ctx, out) => {
      // No write (clean tree, stash failure, or record failure) → ctx untouched. On a recorded
      // quarantine, fold the updated blockedReason back into ctx.tasks so downstream readers
      // (save-tasks epilogue, TUI) see the recovery pointer.
      if (out === undefined) return ctx;
      return {
        ...ctx,
        tasks: (ctx.tasks ?? []).map((t) => (t.id === out.id ? out : t)),
      };
    },
  });

/**
 * Synchronous guard predicate for the quarantine splice: true when the task settled `blocked`. Read
 * from `ctx.tasks` (the settled copy `settle-attempt` writes back) because `settle-attempt` clears
 * `ctx.currentTask`. The escalation-retry path leaves the task `in_progress`, so this is false and
 * the guard skips — no spurious stash. Defensive on a missing task (false → skip).
 *
 * `AbortError` is irrelevant here (a pure predicate cannot abort); the leaf body handles propagation.
 *
 * @public
 */
export const isSettledBlocked = (ctx: ImplementCtx, taskId: TaskId): boolean =>
  ctx.tasks?.find((t) => t.id === taskId)?.status === 'blocked';
