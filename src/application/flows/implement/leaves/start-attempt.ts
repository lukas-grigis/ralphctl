import { type StartAttemptProps, startAttemptUseCase } from '@src/business/task/start-attempt.ts';
import type { InProgressTask, Task } from '@src/domain/entity/task.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { TaskId } from '@src/domain/value/id/task-id.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';
import { resetAttemptScratch } from '@src/application/flows/implement/sprint-scoped-projection.ts';

/**
 * Chain leaf — adapts ctx → startAttemptUseCase → ctx. Business policy (append a `running`
 * attempt, persist, audit log) lives in `@src/business/task/start-attempt.ts`. The
 * leaf adds chain-construction guards (task present in ctx) and projects the new in-progress
 * task back onto ctx alongside cleared per-task verdict state.
 */
export type StartAttemptLeafDeps = Omit<StartAttemptProps, 'task' | 'sprintId'>;

export const startAttemptLeaf = (deps: StartAttemptLeafDeps, taskId: TaskId): Element<ImplementCtx> =>
  leaf<ImplementCtx, { readonly task: Task; readonly sprintId: SprintId }, InProgressTask>(
    `start-attempt-${String(taskId)}`,
    {
      useCase: {
        execute: async (input) => startAttemptUseCase({ ...deps, ...input }),
      },
      input: (ctx) => {
        if (ctx.tasks === undefined) {
          throw new InvalidStateError({
            entity: 'chain',
            currentState: 'pre-start-attempt',
            attemptedAction: `start-attempt-${String(taskId)}`,
            message: `start-attempt-${String(taskId)}: ctx.tasks is undefined — load-tasks must run first`,
          });
        }
        const task = ctx.tasks.find((t) => t.id === taskId);
        if (task === undefined) {
          throw new InvalidStateError({
            entity: 'chain',
            currentState: 'pre-start-attempt',
            attemptedAction: `start-attempt-${String(taskId)}`,
            message: `start-attempt-${String(taskId)}: task '${String(taskId)}' not found in ctx.tasks`,
          });
        }
        return { task, sprintId: ctx.sprintId };
      },
      // Start-attempt is the per-ATTEMPT boundary leaf. Under the outer attempt loop the same ctx
      // flows from one attempt into the next within a single launch, so the gen-eval turn counter,
      // plateau window, round pointer, latest evaluation, proposed commit message, generator /
      // evaluator session ids, and last-turn signal-kind distribution MUST reset here — otherwise
      // attempt 2's inner loop would inherit attempt 1's `plateauHistory` (plateau-on-first-eval), a
      // climbing `genEvalTurn`, a stale commit message, or a cross-attempt session resume that mixes
      // two unrelated bodies of work into one conversational thread. `resetAttemptScratch` is the
      // single, type-derived reset set for this boundary (see `sprint-scoped-projection.ts`) —
      // resetting realises the per-attempt semantics the ctx docs already describe ("a fresh
      // currentTask starts with an empty array"). `currentRoundNum` is recomputed by
      // `resolve-round-num` from max-on-disk so prior rounds are never overwritten even though the
      // in-memory pointer clears.
      output: (ctx, inProgress) => ({
        ...ctx,
        ...resetAttemptScratch(),
        currentTaskId: inProgress.id,
        currentTask: inProgress,
        tasks: (ctx.tasks ?? []).map((t) => (t.id === inProgress.id ? inProgress : t)),
      }),
    }
  );
