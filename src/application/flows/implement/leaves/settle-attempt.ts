import {
  settleAttemptUseCase,
  type SettleAttemptOutput,
  type SettleAttemptProps,
} from '@src/business/task/settle-attempt.ts';
import type { AttemptWarning } from '@src/domain/entity/attempt.ts';
import type { InProgressTask, Task } from '@src/domain/entity/task.ts';
import type { TaskId } from '@src/domain/value/id/task-id.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';
import type { RunTaskVerdict } from '@src/business/task/gen-eval-exit.ts';
import type { GitRunner } from '@src/integration/io/git-runner.ts';
import { gitHasUncommittedChanges } from '@src/integration/io/git-operations.ts';

export interface SettleAttemptLeafDeps {
  readonly taskRepo: SettleAttemptProps['taskRepo'];
  readonly clock: SettleAttemptProps['clock'];
  readonly logger: SettleAttemptProps['logger'];
  /**
   * Used for the worktree-clean guardrail in `settleAttemptUseCase`. Optional so legacy /
   * test callers without a real git runner can still settle (the guardrail is then skipped).
   * Production wires the real GitRunner so dirty-tree settles are refused.
   */
  readonly gitRunner?: GitRunner;
}

export interface SettleAttemptLeafOpts {
  /** Worktree the commit-task leaf ran against — used for the dirty-tree guardrail. */
  readonly cwd: AbsolutePath;
}

interface SettleInput {
  readonly task: InProgressTask;
  readonly sprintId: SprintId;
  readonly verdict: RunTaskVerdict;
  readonly blockedReason?: string;
  readonly warning?: AttemptWarning;
}

/**
 * Chain leaf — projects ctx into a SettleInput and delegates to settleAttemptUseCase. Business
 * policy (decision tree for verdict + blockedReason + warning → final task status) lives in
 * `@src/business/task/settle-attempt.ts`.
 */
export const settleAttemptLeaf = (
  deps: SettleAttemptLeafDeps,
  opts: SettleAttemptLeafOpts,
  taskId: TaskId
): Element<ImplementCtx> => {
  const { gitRunner } = deps;
  const hasUncommittedChanges: SettleAttemptProps['hasUncommittedChanges'] | undefined =
    gitRunner !== undefined ? () => gitHasUncommittedChanges(gitRunner, opts.cwd) : undefined;
  return leaf<ImplementCtx, SettleInput, SettleAttemptOutput>(`settle-attempt-${String(taskId)}`, {
    useCase: {
      execute: (input) =>
        settleAttemptUseCase({
          ...deps,
          ...input,
          cwd: opts.cwd,
          ...(hasUncommittedChanges !== undefined ? { hasUncommittedChanges } : {}),
        }),
    },
    input: (ctx) => {
      if (ctx.currentTask === undefined || ctx.currentTask.id !== taskId) {
        throw new InvalidStateError({
          entity: 'chain',
          currentState: 'pre-settle',
          attemptedAction: `settle-attempt-${String(taskId)}`,
          message: `settle-attempt-${String(taskId)}: ctx.currentTask is missing or mismatched`,
        });
      }
      if (ctx.currentTask.status !== 'in_progress') {
        throw new InvalidStateError({
          entity: 'task',
          currentState: ctx.currentTask.status,
          attemptedAction: `settle-attempt-${String(taskId)}`,
          message: `settle-attempt-${String(taskId)}: expected in_progress task — got '${ctx.currentTask.status}'`,
        });
      }
      if (ctx.lastVerdict === undefined && ctx.lastBlockReason === undefined) {
        throw new InvalidStateError({
          entity: 'chain',
          currentState: 'pre-settle',
          attemptedAction: `settle-attempt-${String(taskId)}`,
          message: `settle-attempt-${String(taskId)}: no verdict or block reason on ctx — at least one turn must run`,
        });
      }
      const warning: AttemptWarning | undefined =
        ctx.lastVerifyResult !== undefined && ctx.lastVerifyResult.kind === 'verify-failed'
          ? {
              kind: 'verify-failed',
              exitCode: ctx.lastVerifyResult.exitCode,
              stderr: ctx.lastVerifyResult.stderr,
            }
          : ctx.lastWarning;
      return {
        task: ctx.currentTask,
        sprintId: ctx.sprintId,
        verdict: ctx.lastVerdict ?? 'failed',
        ...(ctx.lastBlockReason !== undefined ? { blockedReason: ctx.lastBlockReason } : {}),
        ...(warning !== undefined ? { warning } : {}),
      };
    },
    output: (ctx, settled) => {
      const tasks = (ctx.tasks ?? []).map((t) => (t.id === settled.id ? (settled as Task) : t));
      return {
        ...ctx,
        tasks,
        currentTask: undefined,
        currentTaskId: undefined,
        lastVerdict: undefined,
        lastBlockReason: undefined,
        lastExit: undefined,
        lastWarning: undefined,
        lastVerifyResult: undefined,
        lastCommitSha: undefined,
      };
    },
  });
};
