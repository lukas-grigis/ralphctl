import type { StepContext } from '@src/domain/context.ts';
import type { PipelineDefinition } from '../pipeline/types.ts';
import type { RefineSummary, RefineTicketRequirementsUseCase } from '../usecases/refine.ts';
import type { PlanSummary, PlanSprintTasksUseCase } from '../usecases/plan.ts';
import { Result } from '@src/domain/types.ts';
import { ParseError } from '@src/domain/errors.ts';
import { step, pipeline } from '../pipeline/helpers.ts';

export interface RefinePlanContext extends StepContext {
  refineSummary?: RefineSummary;
  planSummary?: PlanSummary;
}

export function createRefinePlanPipeline(
  refineUseCase: RefineTicketRequirementsUseCase,
  planUseCase: PlanSprintTasksUseCase
): PipelineDefinition {
  const refineStep = step<RefinePlanContext>('refine', async (ctx) => {
    const result = await refineUseCase.execute(ctx.sprintId, { auto: true });
    if (!result.ok) {
      return Result.error(result.error);
    }
    return Result.ok({ refineSummary: result.value });
  });

  const planStep = step<RefinePlanContext>(
    'plan',
    async (ctx) => {
      const result = await planUseCase.execute(ctx.sprintId, { auto: true });
      if (!result.ok) {
        return Result.error(result.error);
      }
      return Result.ok({ planSummary: result.value });
    },
    {
      pre: (ctx) => {
        if (!ctx.refineSummary?.allApproved) {
          return Result.error(
            new ParseError('Not all tickets have approved requirements. Refine step must approve all tickets first.')
          );
        }
        return Result.ok(ctx);
      },
    }
  );

  return pipeline('refine-plan', [refineStep, planStep]);
}
