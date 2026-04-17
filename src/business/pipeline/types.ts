import type { StepContext } from '@src/domain/context.ts';
import type { DomainError } from '@src/domain/errors.ts';
import type { DomainResult } from '@src/domain/types.ts';

/** Allow step functions to be sync or async */
type MaybePromise<T> = T | Promise<T>;

/** A single step in a pipeline */
export interface PipelineStep<TCtx extends StepContext = StepContext> {
  /** Unique name for this step (used in error messages and logging) */
  name: string;

  /** Execute the step's core logic */
  execute: (ctx: TCtx) => MaybePromise<DomainResult<Partial<TCtx>>>;

  /** Optional lifecycle hooks */
  hooks?: {
    /** Runs before execute — can modify context */
    pre?: (ctx: TCtx) => MaybePromise<DomainResult<TCtx>>;
    /** Runs after execute — can modify the step's output */
    post?: (ctx: TCtx, result: Partial<TCtx>) => MaybePromise<DomainResult<Partial<TCtx>>>;
  };
}

/** Definition of a composable pipeline */
export interface PipelineDefinition<TCtx extends StepContext = StepContext> {
  /** Pipeline name (for logging/errors) */
  name: string;
  /** Ordered list of steps */
  steps: PipelineStep<TCtx>[];
}

/** Result of a pipeline execution */
export interface PipelineResult<TCtx extends StepContext = StepContext> {
  /** Final accumulated context */
  context: TCtx;
  /** Per-step diagnostics */
  stepResults: StepExecutionRecord[];
}

/** Record of a single step's execution */
export interface StepExecutionRecord {
  stepName: string;
  status: 'success' | 'skipped' | 'failed';
  durationMs: number;
  error?: DomainError;
}
