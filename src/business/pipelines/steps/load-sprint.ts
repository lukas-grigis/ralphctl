import type { StepContext } from '@src/domain/context.ts';
import type { Sprint } from '@src/domain/models.ts';
import type { DomainResult } from '@src/domain/types.ts';
import { Result } from '@src/domain/types.ts';
import { DomainError, SprintNotFoundError } from '@src/domain/errors.ts';
import type { PersistencePort } from '@src/business/ports/persistence.ts';
import { step } from '@src/business/pipelines/framework/helpers.ts';
import type { PipelineStep } from '@src/business/pipelines/framework/types.ts';

/**
 * Read `ctx.sprintId` and load the sprint into `ctx.sprint`.
 *
 * Returns `SprintNotFoundError` if persistence rejects the ID. Any other
 * DomainError surfaces unchanged; non-DomainError throws are rewrapped.
 */
export function loadSprintStep<TCtx extends StepContext & { sprint?: Sprint }>(
  persistence: PersistencePort
): PipelineStep<TCtx> {
  return step<TCtx>('load-sprint', async (ctx): Promise<DomainResult<Partial<TCtx>>> => {
    try {
      const sprint = await persistence.getSprint(ctx.sprintId);
      const partial: Partial<TCtx> = { sprint } as Partial<TCtx>;
      return Result.ok(partial) as DomainResult<Partial<TCtx>>;
    } catch (err) {
      if (err instanceof SprintNotFoundError) return Result.error(err);
      if (err instanceof DomainError) return Result.error(err);
      return Result.error(new SprintNotFoundError(ctx.sprintId));
    }
  });
}
