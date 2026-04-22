import type { StepContext } from '@src/domain/context.ts';
import type { Sprint, SprintStatus } from '@src/domain/models.ts';
import type { DomainResult } from '@src/domain/types.ts';
import { Result } from '@src/domain/types.ts';
import { SprintStatusError, StepError } from '@src/domain/errors.ts';
import { step } from '@src/business/pipelines/framework/helpers.ts';
import type { PipelineStep } from '@src/business/pipelines/framework/types.ts';

/**
 * Assert that `ctx.sprint.status` is one of the expected values.
 *
 * `expectedStatuses` is variadic so callers can accept multiple — e.g.
 * `['draft', 'active']` for operations that run in either state. Emits a
 * `SprintStatusError` if the status doesn't match, or a `StepError` if
 * `ctx.sprint` is missing (the `load-sprint` step must run earlier).
 */
export function assertSprintStatusStep<TCtx extends StepContext & { sprint?: Sprint }>(
  expectedStatuses: SprintStatus[],
  operation: string
): PipelineStep<TCtx> {
  return step<TCtx>('assert-sprint-status', (ctx): DomainResult<Partial<TCtx>> => {
    const sprint = ctx.sprint;
    if (!sprint) {
      return Result.error(
        new StepError('assert-sprint-status requires ctx.sprint — call loadSprintStep first', 'assert-sprint-status')
      );
    }

    if (!expectedStatuses.includes(sprint.status)) {
      const expected = expectedStatuses.join(' | ');
      return Result.error(
        new SprintStatusError(
          `Sprint '${sprint.name}' is ${sprint.status}, expected ${expected} for ${operation}`,
          sprint.status,
          operation
        )
      );
    }

    const empty: Partial<TCtx> = {};
    return Result.ok(empty) as DomainResult<Partial<TCtx>>;
  });
}
