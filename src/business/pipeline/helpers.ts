import type { StepContext } from '@src/domain/context.ts';
import { Result } from '@src/domain/types.ts';
import type { DomainResult } from '@src/domain/types.ts';
import { DomainError, SpawnError, StepError } from '@src/domain/errors.ts';
import { executePipeline } from './pipeline.ts';
import type { PipelineDefinition, PipelineStep } from './types.ts';

/** Create a named pipeline step with optional hooks */
export function step<TCtx extends StepContext>(
  name: string,
  execute: PipelineStep<TCtx>['execute'],
  hooks?: PipelineStep<TCtx>['hooks']
): PipelineStep<TCtx> {
  return { name, execute, hooks };
}

/** Create a pipeline definition from steps */
export function pipeline<TCtx extends StepContext>(
  name: string,
  steps: PipelineStep<TCtx>[]
): PipelineDefinition<TCtx> {
  return { name, steps };
}

/**
 * Wrap a `PipelineDefinition` as a single `PipelineStep`.
 *
 * The inner pipeline executes with the outer context; on success its final
 * context delta is merged into the outer context by the outer `executePipeline`.
 * On inner failure, the inner `StepError` is wrapped with the nested pipeline's
 * name prepended (e.g. `[refine > export-requirements] ...`) so the failing
 * step path is traceable from the top-level error message.
 */
export function nested<TCtx extends StepContext>(
  name: string,
  innerPipeline: PipelineDefinition<TCtx>
): PipelineStep<TCtx> {
  return step<TCtx>(name, async (ctx): Promise<DomainResult<Partial<TCtx>>> => {
    const result = await executePipeline(innerPipeline, ctx);
    if (!result.ok) {
      const innerError = result.error;
      const stepPath = innerError instanceof StepError ? `${name} > ${innerError.stepName}` : name;
      return Result.error(new StepError(`[${stepPath}] ${innerError.message}`, name, innerError));
    }
    // Return the full final context as a Partial<TCtx> so the outer
    // executePipeline merges it via spread.
    const finalCtx: Partial<TCtx> = { ...result.value.context };
    // Cast needed: Result.ok's return type `Result.Ok<Partial<TCtx>>` doesn't
    // unify with `DomainResult<Partial<TCtx>>` through the distributive
    // conditional when TCtx is generic.
    return Result.ok(finalCtx) as DomainResult<Partial<TCtx>>;
  });
}

/**
 * Wrap a step, overriding its name.
 *
 * Shared steps expose generic names (e.g. `assert-sprint-status`); pipelines
 * often want a more specific label in their step order (e.g. `assert-draft`).
 * `renameStep` preserves the step's `execute` and `hooks` — only the `name`
 * field changes — so step-order assertions in pipeline tests read naturally.
 */
export function renameStep<TCtx extends StepContext>(name: string, inner: PipelineStep<TCtx>): PipelineStep<TCtx> {
  return { ...inner, name };
}

/**
 * Insert `newStep` immediately before the step named `targetStepName`.
 * Throws (programmer error) if the target isn't found.
 */
export function insertBefore<TCtx extends StepContext>(
  pipeline_: PipelineDefinition<TCtx>,
  targetStepName: string,
  newStep: PipelineStep<TCtx>
): PipelineDefinition<TCtx> {
  const idx = indexOfStep(pipeline_, targetStepName);
  const steps = [...pipeline_.steps.slice(0, idx), newStep, ...pipeline_.steps.slice(idx)];
  return { ...pipeline_, steps };
}

/**
 * Insert `newStep` immediately after the step named `targetStepName`.
 * Throws (programmer error) if the target isn't found.
 */
export function insertAfter<TCtx extends StepContext>(
  pipeline_: PipelineDefinition<TCtx>,
  targetStepName: string,
  newStep: PipelineStep<TCtx>
): PipelineDefinition<TCtx> {
  const idx = indexOfStep(pipeline_, targetStepName);
  const steps = [...pipeline_.steps.slice(0, idx + 1), newStep, ...pipeline_.steps.slice(idx + 1)];
  return { ...pipeline_, steps };
}

/**
 * Replace the step named `targetStepName` with `newStep`.
 * Throws (programmer error) if the target isn't found.
 */
export function replace<TCtx extends StepContext>(
  pipeline_: PipelineDefinition<TCtx>,
  targetStepName: string,
  newStep: PipelineStep<TCtx>
): PipelineDefinition<TCtx> {
  const idx = indexOfStep(pipeline_, targetStepName);
  const steps = [...pipeline_.steps.slice(0, idx), newStep, ...pipeline_.steps.slice(idx + 1)];
  return { ...pipeline_, steps };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function indexOfStep<TCtx extends StepContext>(pipeline_: PipelineDefinition<TCtx>, targetStepName: string): number {
  const idx = pipeline_.steps.findIndex((s) => s.name === targetStepName);
  if (idx === -1) {
    throw new Error(
      `Step '${targetStepName}' not found in pipeline '${pipeline_.name}'. Available: [${pipeline_.steps.map((s) => s.name).join(', ')}]`
    );
  }
  return idx;
}

/**
 * Walk a `DomainError`'s cause chain to find the originating `SpawnError` —
 * useful when a step-boundary wrapped the spawn failure in `StepError`.
 * Returns the `SpawnError` instance if one exists, `null` otherwise.
 */
export function findSpawnError(err: DomainError): SpawnError | null {
  let current: Error | undefined = err;
  while (current) {
    if (current instanceof SpawnError) return current;
    current = current instanceof DomainError ? current.cause : undefined;
  }
  return null;
}
