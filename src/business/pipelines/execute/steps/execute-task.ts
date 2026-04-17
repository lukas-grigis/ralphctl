import type { DomainResult } from '@src/domain/types.ts';
import { Result } from '@src/domain/types.ts';
import { ParseError } from '@src/domain/errors.ts';
import type { ExecutionOptions } from '@src/domain/context.ts';
import { step } from '@src/business/pipelines/framework/helpers.ts';
import type { PipelineStep } from '@src/business/pipelines/framework/types.ts';
import type { LoggerPort } from '@src/business/ports/logger.ts';
import type { ExecuteTasksUseCase } from '@src/business/usecases/execute.ts';
import type { PerTaskContext } from '../per-task-context.ts';

/**
 * Delegate to `ExecuteTasksUseCase.executeOneTask` — the canonical task body
 * (prompt build, AI spawn, signal dispatch, verification extraction).
 *
 * Writes `executionResult` and `generatorModel` to context. On a
 * `success: false` result (blocked or errored), returns `ParseError` so the
 * scheduler's retry policy in commit 3 can map this to `skip-repo`.
 * `SpawnError` (including rate-limit) thrown inside the use case
 * propagates — the pipeline framework wraps it as `StepError`, and the
 * retry policy unwraps the cause chain.
 *
 * Session resume: when `taskSessionIds` contains an entry for the current
 * task (populated by the scheduler on rate-limit capture), the step injects
 * `resumeSessionId` into the options bag so the provider relaunches the AI
 * session with `--resume` / `--resume=<id>` continuity.
 */
export function executeTask(deps: {
  useCase: ExecuteTasksUseCase;
  options: ExecutionOptions;
  /**
   * Shared map of task-id → captured session-id, populated by the
   * scheduler's rate-limit retry policy (see `execute-tasks` step in
   * `src/business/pipelines/execute.ts`). Optional — when absent or empty
   * for a task, behavior is unchanged (fresh session).
   */
  taskSessionIds?: Map<string, string>;
  logger?: LoggerPort;
}): PipelineStep<PerTaskContext> {
  return step<PerTaskContext>('execute-task', async (ctx): Promise<DomainResult<Partial<PerTaskContext>>> => {
    const { task, sprint } = ctx;
    const resumeSessionId = deps.taskSessionIds?.get(task.id);
    if (resumeSessionId) {
      deps.logger?.info(`Resuming previous session: ${resumeSessionId.slice(0, 8)}...`);
    }

    const result = await deps.useCase.executeOneTask(task, sprint, {
      ...deps.options,
      ...(resumeSessionId ? { resumeSessionId } : {}),
      ...(ctx.contractPath ? { contractPath: ctx.contractPath } : {}),
    });

    if (!result.success) {
      return Result.error(new ParseError(`Task not completed: ${result.blocked ?? 'Unknown reason'}`));
    }

    const partial: Partial<PerTaskContext> = {
      executionResult: result,
      generatorModel: result.model ?? null,
    };
    return Result.ok(partial) as DomainResult<Partial<PerTaskContext>>;
  });
}
