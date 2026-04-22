import type { DomainResult } from '@src/domain/types.ts';
import { Result } from '@src/domain/types.ts';
import { DomainError, StorageError } from '@src/domain/errors.ts';
import type { PersistencePort } from '@src/business/ports/persistence.ts';
import type { LoggerPort } from '@src/business/ports/logger.ts';
import { step } from '@src/business/pipelines/framework/helpers.ts';
import type { PipelineStep } from '@src/business/pipelines/framework/types.ts';
import type { PerTaskContext } from '../per-task-context.ts';

/**
 * If the AI emitted `<task-verified>`, persist the verified flag and output
 * on the task. No-op otherwise — verification is optional and the task can
 * still proceed to post-task-check + evaluator.
 */
export function storeVerification(deps: {
  persistence: PersistencePort;
  logger: LoggerPort;
}): PipelineStep<PerTaskContext> {
  return step<PerTaskContext>('store-verification', async (ctx): Promise<DomainResult<Partial<PerTaskContext>>> => {
    const { task, sprint, executionResult } = ctx;
    if (!executionResult?.verified) {
      const empty: Partial<PerTaskContext> = {};
      return Result.ok(empty);
    }

    try {
      await deps.persistence.updateTask(
        task.id,
        { verified: true, verificationOutput: executionResult.verificationOutput },
        sprint.id
      );
    } catch (err) {
      if (err instanceof DomainError) return Result.error(err);
      return Result.error(
        new StorageError(
          `Failed to store verification: ${err instanceof Error ? err.message : String(err)}`,
          err instanceof Error ? err : undefined
        )
      );
    }

    deps.logger.success(`Verification passed: ${task.name}`);

    const empty: Partial<PerTaskContext> = {};
    return Result.ok(empty);
  });
}
