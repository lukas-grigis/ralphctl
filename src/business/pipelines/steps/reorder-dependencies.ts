import type { StepContext } from '@src/domain/context.ts';
import type { Task } from '@src/domain/models.ts';
import type { DomainResult } from '@src/domain/types.ts';
import { Result } from '@src/domain/types.ts';
import { DomainError, StorageError } from '@src/domain/errors.ts';
import type { PersistencePort } from '@src/business/ports/persistence.ts';
import { step } from '@src/business/pipelines/framework/helpers.ts';
import type { PipelineStep } from '@src/business/pipelines/framework/types.ts';

/**
 * Reorder tasks by their dependency graph, then refresh `ctx.tasks` from
 * persistence so subsequent steps see the new ordering.
 *
 * Domain errors from `reorderByDependencies` (e.g. `DependencyCycleError`)
 * propagate unchanged.
 */
export function reorderDependenciesStep<TCtx extends StepContext & { tasks?: Task[] }>(
  persistence: PersistencePort
): PipelineStep<TCtx> {
  return step<TCtx>('reorder-dependencies', async (ctx): Promise<DomainResult<Partial<TCtx>>> => {
    try {
      await persistence.reorderByDependencies(ctx.sprintId);
      const tasks = await persistence.getTasks(ctx.sprintId);
      const partial: Partial<TCtx> = { tasks } as Partial<TCtx>;
      return Result.ok(partial) as DomainResult<Partial<TCtx>>;
    } catch (err) {
      if (err instanceof DomainError) return Result.error(err);
      return Result.error(
        new StorageError(
          `Failed to reorder tasks for sprint ${ctx.sprintId}: ${err instanceof Error ? err.message : String(err)}`,
          err instanceof Error ? err : undefined
        )
      );
    }
  });
}
