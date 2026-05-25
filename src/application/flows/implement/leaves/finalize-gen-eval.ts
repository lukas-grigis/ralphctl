import { finalizeGenEvalUseCase, type FinalizeGenEvalOutput } from '@src/business/task/finalize-gen-eval.ts';
import type { GenEvalExit } from '@src/business/task/gen-eval-exit.ts';
import type { EventBus } from '@src/business/observability/event-bus.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { InProgressTask, Task } from '@src/domain/entity/task.ts';
import type { TaskId } from '@src/domain/value/id/task-id.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { UpdateTask } from '@src/domain/repository/task/update-task.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';

/**
 * Chain leaf — runs after the gen-eval loop. Calls {@link finalizeGenEvalUseCase} which maps
 * the loop's terminal `GenEvalExit` to a verdict + warning and persists the task. When the
 * loop exited via budget (no leaf wrote `ctx.lastExit`), the use case synthesises a
 * `budget-exhausted` exit from the current `maxTurns` config and the recorded turn count.
 *
 * `configuredGeneratorModel` is the implement chain's `settings.ai.implement.generator.model`.
 * The leaf falls through to `task.escalatedToModel` first (matching the generator leaf's
 * resolution order); the resulting value is what the escalation policy looks up in the
 * merged map on a plateau exit.
 */
export interface FinalizeGenEvalLeafDeps {
  readonly taskRepo: UpdateTask;
  readonly readConfig: () => Promise<{
    readonly maxTurns: number;
    readonly escalateOnPlateau: boolean;
    readonly escalationMap: Readonly<Record<string, string>>;
  }>;
  readonly logger: Logger;
  readonly eventBus: EventBus;
  readonly clock: () => IsoTimestamp;
  readonly configuredGeneratorModel: string;
}

interface FinalizeInput {
  readonly task: InProgressTask;
  readonly sprintId: SprintId;
  readonly exit?: GenEvalExit;
  readonly turnsUsed: number;
  readonly generatorModel: string;
}

export const finalizeGenEvalLeaf = (deps: FinalizeGenEvalLeafDeps, taskId: TaskId): Element<ImplementCtx> =>
  leaf<ImplementCtx, FinalizeInput, FinalizeGenEvalOutput>(`finalize-gen-eval-${String(taskId)}`, {
    useCase: {
      execute: async (input) =>
        finalizeGenEvalUseCase({
          task: input.task,
          sprintId: input.sprintId,
          ...(input.exit !== undefined ? { exit: input.exit } : {}),
          turnsUsed: input.turnsUsed,
          readConfig: deps.readConfig,
          taskRepo: deps.taskRepo,
          logger: deps.logger,
          eventBus: deps.eventBus,
          clock: deps.clock,
          generatorModel: input.generatorModel,
        }),
    },
    input: (ctx) => {
      if (ctx.currentTask === undefined || ctx.currentTask.id !== taskId) {
        throw new InvalidStateError({
          entity: 'chain',
          currentState: 'pre-finalize',
          attemptedAction: `finalize-gen-eval-${String(taskId)}`,
          message: `finalize-gen-eval-${String(taskId)}: ctx.currentTask missing or mismatched`,
        });
      }
      if (ctx.currentTask.status !== 'in_progress') {
        throw new InvalidStateError({
          entity: 'task',
          currentState: ctx.currentTask.status,
          attemptedAction: `finalize-gen-eval-${String(taskId)}`,
          message: `finalize-gen-eval-${String(taskId)}: expected in_progress task`,
        });
      }
      // Per-attempt generator model is the task's escalation override when present, else the
      // configured settings row — matches the resolution order in `generator.ts`. Read here
      // so the escalation policy can look up the rung above the actual model that ran.
      const generatorModel = ctx.currentTask.escalatedToModel ?? deps.configuredGeneratorModel;
      return {
        task: ctx.currentTask,
        sprintId: ctx.sprintId,
        ...(ctx.lastExit !== undefined ? { exit: ctx.lastExit } : {}),
        turnsUsed: ctx.genEvalTurn ?? 0,
        generatorModel,
      };
    },
    output: (ctx, out) => {
      const tasks = (ctx.tasks ?? []).map((t) => (t.id === out.task.id ? (out.task as Task) : t));
      return {
        ...ctx,
        currentTask: out.task,
        tasks,
        lastExit: out.exit,
        lastVerdict: out.verdict,
        ...(out.warning !== undefined ? { lastWarning: out.warning } : {}),
        ...(out.blockedReason !== undefined ? { lastBlockReason: out.blockedReason } : {}),
        ...(out.shouldFailAttempt === true ? { lastShouldFailAttempt: true } : {}),
      };
    },
  });
