import { Result } from '@src/domain/types.ts';
import type { DomainResult } from '@src/domain/types.ts';
import { ParseError } from '@src/domain/errors.ts';
import type { ExecutionOptions } from '@src/domain/context.ts';
import { step } from '@src/business/pipeline/helpers.ts';
import type { PipelineStep } from '@src/business/pipeline/types.ts';
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
 */
export function executeTask(deps: {
  useCase: ExecuteTasksUseCase;
  options: ExecutionOptions;
}): PipelineStep<PerTaskContext> {
  return step<PerTaskContext>('execute-task', async (ctx): Promise<DomainResult<Partial<PerTaskContext>>> => {
    const { task, sprint } = ctx;
    const result = await deps.useCase.executeOneTask(task, sprint, deps.options);

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
