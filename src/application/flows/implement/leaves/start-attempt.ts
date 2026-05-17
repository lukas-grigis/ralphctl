import { startAttemptUseCase, type StartAttemptProps } from '@src/business/task/start-attempt.ts';
import type { InProgressTask, Task } from '@src/domain/entity/task.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { TaskId } from '@src/domain/value/id/task-id.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';

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
      output: (ctx, inProgress) => ({
        ...ctx,
        currentTaskId: inProgress.id,
        currentTask: inProgress,
        tasks: (ctx.tasks ?? []).map((t) => (t.id === inProgress.id ? inProgress : t)),
        lastVerdict: undefined,
        lastBlockReason: undefined,
      }),
    }
  );
