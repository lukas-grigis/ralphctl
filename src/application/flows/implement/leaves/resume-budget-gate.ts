import { Result } from '@src/domain/result.ts';
import type { EventBus } from '@src/business/observability/event-bus.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import { publishTaskBlocked } from '@src/business/task/publish-task-blocked.ts';
import { blockExhaustedResumeUseCase } from '@src/business/task/start-attempt.ts';
import type { FindTaskById } from '@src/domain/repository/task/find-task-by-id.ts';
import type { UpdateTask } from '@src/domain/repository/task/update-task.ts';
import type { BlockedTask, Task } from '@src/domain/entity/task.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { TaskId } from '@src/domain/value/id/task-id.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';
import { replaceTask } from '@src/application/flows/implement/leaves/_shared/replace-task.ts';

/**
 * Resume budget gate — the second per-task precondition, right after the dependency gate. A task a
 * crash left with a `running` attempt is resumed by `start-attempt`, which settles that attempt as
 * harness-interrupted first. When that settle exhausts the attempt budget, this gate persists the
 * block up front instead, so the `task-runnable` guard skips the body: no workspace, no skills
 * install, and on the serial path no error that would end the run and strand every later task
 * (the continue-on-blocked contract). `start-attempt` keeps the same check as a backstop.
 *
 * The block is announced here, once it is durable — no later step re-announces it.
 */
export interface ResumeBudgetGateLeafDeps {
  readonly taskRepo: UpdateTask & FindTaskById;
  readonly clock: () => IsoTimestamp;
  readonly logger: Logger;
  readonly eventBus: EventBus;
}

interface ResumeBudgetGateInput {
  readonly task: Task;
  readonly sprintId: SprintId;
}

interface ResumeBudgetGateOutput {
  /** The newly-blocked task when the resume would exhaust the budget; absent otherwise. */
  readonly blocked?: BlockedTask;
}

export const resumeBudgetGateLeaf = (deps: ResumeBudgetGateLeafDeps, taskId: TaskId): Element<ImplementCtx> =>
  leaf<ImplementCtx, ResumeBudgetGateInput, ResumeBudgetGateOutput>(`resume-budget-gate-${String(taskId)}`, {
    useCase: {
      execute: async (input): Promise<Result<ResumeBudgetGateOutput, DomainError>> => {
        // An already-settled task (e.g. the dependency gate just blocked it) is not resumed.
        if (input.task.status !== 'todo' && input.task.status !== 'in_progress') return Result.ok({});
        const blocked = await blockExhaustedResumeUseCase({ ...deps, ...input });
        if (!blocked.ok) return Result.error(blocked.error);
        if (blocked.value === undefined) return Result.ok({});
        publishTaskBlocked(deps.eventBus, blocked.value, deps.clock());
        return Result.ok({ blocked: blocked.value });
      },
    },
    input: (ctx) => {
      const task = ctx.tasks?.find((t) => t.id === taskId);
      if (task === undefined) {
        throw new InvalidStateError({
          entity: 'chain',
          currentState: 'pre-resume-budget-gate',
          attemptedAction: `resume-budget-gate-${String(taskId)}`,
          message: `resume-budget-gate-${String(taskId)}: task '${String(taskId)}' not found in ctx.tasks — load-tasks must run first`,
        });
      }
      return { task, sprintId: ctx.sprintId };
    },
    output: (ctx, out) => (out.blocked === undefined ? ctx : { ...ctx, tasks: replaceTask(ctx.tasks, out.blocked) }),
    label: 'Check attempt budget',
    internal: true,
  });
