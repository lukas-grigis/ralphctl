import { Result } from '@src/domain/result.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { TaskId } from '@src/domain/value/id/task-id.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';
import { nextRoundNum } from '@src/application/flows/implement/leaves/round-artifacts.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';

/**
 * Claim the next on-disk round number for the in-flight task and stamp it onto
 * `ctx.currentRoundNum`. Runs FIRST inside every gen-eval iteration so:
 *
 *   - The session-meta stamp leaves (generator + evaluator) can resolve their `roundN`
 *     attribution from ctx without reaching back into disk state themselves.
 *   - The generator + evaluator leaves stop owning the "what round are we?" question — they
 *     simply read `ctx.currentRoundNum` and compute their per-round paths from it.
 *
 * Why factor it out: prior to this leaf the generator leaf called `nextRoundNum(workspaceRoot)`
 * INSIDE its `execute(...)`. That coupled the spawn leaf to a disk read and meant the meta
 * stamp leaf running just before it would have to recompute the same value (race: a sibling
 * write between the two reads would diverge). Centralising the claim in one element guarantees
 * the same N across stamp + generator + evaluator within a single turn.
 *
 * Single-writer contract: see {@link nextRoundNum} — the implement chain holds a per-sprint
 * advisory lock so two concurrent ralphctl processes can't race the same `rounds/<N>/`.
 */
interface ResolveRoundNumInput {
  readonly workspaceRoot: AbsolutePath;
}

export const resolveRoundNumLeaf = (taskId: TaskId): Element<ImplementCtx> =>
  leaf<ImplementCtx, ResolveRoundNumInput, number>(`resolve-round-num-${String(taskId)}`, {
    useCase: {
      execute: async (input) => {
        const n = await nextRoundNum(input.workspaceRoot);
        return Result.ok(n);
      },
    },
    input: (ctx) => {
      if (ctx.currentTask === undefined || ctx.currentTask.id !== taskId) {
        throw new InvalidStateError({
          entity: 'chain',
          currentState: 'pre-resolve-round-num',
          attemptedAction: `resolve-round-num-${String(taskId)}`,
          message: `resolve-round-num-${String(taskId)}: ctx.currentTask missing or mismatched`,
        });
      }
      if (ctx.taskWorkspaceRoot === undefined) {
        throw new InvalidStateError({
          entity: 'chain',
          currentState: 'pre-resolve-round-num',
          attemptedAction: `resolve-round-num-${String(taskId)}`,
          message: `resolve-round-num-${String(taskId)}: ctx.taskWorkspaceRoot missing — buildTaskWorkspaceLeaf must run first`,
        });
      }
      return { workspaceRoot: ctx.taskWorkspaceRoot };
    },
    output: (ctx, roundNum) => ({ ...ctx, currentRoundNum: roundNum }),
  });
