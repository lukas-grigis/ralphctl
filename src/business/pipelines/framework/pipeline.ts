import type { DomainResult } from '@src/domain/types.ts';
import { Result } from '@src/domain/types.ts';
import type { DomainError } from '@src/domain/errors.ts';
import { StepError } from '@src/domain/errors.ts';
import type { StepContext } from '@src/domain/context.ts';
import type { PipelineDefinition, PipelineResult, StepExecutionRecord } from './types.ts';

/**
 * Extract the value from a DomainResult, narrowing past the conditional type.
 * The typescript-result library's `.value` accessor returns a conditional type
 * that doesn't resolve through generics, so we use this helper after `.ok` checks.
 */
function unwrapValue<T>(result: DomainResult<T>): T {
  return result.value as T;
}

function unwrapError(result: DomainResult<unknown>): DomainError {
  // After an `.ok === false` check the error is always present.
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  return result.error!;
}

/**
 * Execute a pipeline of composable steps.
 *
 * Each step receives the accumulated context from previous steps.
 * Steps can have pre/post hooks that modify context or results.
 * If any step fails, the pipeline stops and returns the error.
 *
 * @param pipeline - The pipeline definition with named steps
 * @param initialContext - Starting context
 * @returns The final accumulated context or an error
 */
export async function executePipeline<TCtx extends StepContext>(
  pipeline: PipelineDefinition<TCtx>,
  initialContext: TCtx
): Promise<DomainResult<PipelineResult<TCtx>>> {
  let ctx = { ...initialContext };
  const stepResults: StepExecutionRecord[] = [];
  let stepsRun = 0;

  for (const step of pipeline.steps) {
    // Cooperative cancellation: if the caller's AbortSignal has fired and
    // we've already executed at least one step, stop launching further steps.
    // The very first step always runs — steps that need to react to an
    // already-aborted signal (notably `forEachTask`) own the semantics
    // themselves and populate a terminal summary in their own result.
    if (stepsRun > 0 && ctx.abortSignal?.aborted) break;

    const startTime = Date.now();

    try {
      // Run pre-hook if defined
      if (step.hooks?.pre) {
        const preResult = await step.hooks.pre(ctx);
        if (!preResult.ok) {
          const error = unwrapError(preResult);
          stepResults.push({
            stepName: step.name,
            status: 'failed',
            durationMs: Date.now() - startTime,
            error,
          });
          return Result.error(
            new StepError(`Pre-hook failed for step '${step.name}': ${error.message}`, step.name, error)
          );
        }
        ctx = unwrapValue(preResult);
      }

      // Execute the step
      const stepResult = await step.execute(ctx);
      if (!stepResult.ok) {
        const error = unwrapError(stepResult);
        stepResults.push({
          stepName: step.name,
          status: 'failed',
          durationMs: Date.now() - startTime,
          error,
        });
        return Result.error(new StepError(`Step '${step.name}' failed: ${error.message}`, step.name, error));
      }

      // Merge step output into context
      const stepValue = unwrapValue(stepResult);
      ctx = { ...ctx, ...stepValue };

      // Run post-hook if defined
      if (step.hooks?.post) {
        const postResult = await step.hooks.post(ctx, stepValue);
        if (!postResult.ok) {
          const error = unwrapError(postResult);
          stepResults.push({
            stepName: step.name,
            status: 'failed',
            durationMs: Date.now() - startTime,
            error,
          });
          return Result.error(
            new StepError(`Post-hook failed for step '${step.name}': ${error.message}`, step.name, error)
          );
        }
        ctx = { ...ctx, ...unwrapValue(postResult) };
      }

      stepResults.push({
        stepName: step.name,
        status: 'success',
        durationMs: Date.now() - startTime,
      });
      stepsRun++;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      stepResults.push({
        stepName: step.name,
        status: 'failed',
        durationMs: Date.now() - startTime,
        error: new StepError(`Unexpected error in step '${step.name}': ${error.message}`, step.name, error),
      });
      return Result.error(new StepError(`Unexpected error in step '${step.name}': ${error.message}`, step.name, error));
    }
  }

  return Result.ok({ context: ctx, stepResults });
}
