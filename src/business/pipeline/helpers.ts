import type { StepContext } from '@src/domain/context.ts';
import type { PipelineStep, PipelineDefinition } from './types.ts';

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
