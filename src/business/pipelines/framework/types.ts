import type { StepContext } from '@src/domain/context.ts';
import type { DomainError } from '@src/domain/errors.ts';
import type { DomainResult } from '@src/domain/types.ts';
import type { RateLimitCoordinatorPort } from '@src/business/ports/rate-limit-coordinator.ts';
import type { SignalBusPort } from '@src/business/ports/signal-bus.ts';

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

/**
 * Shared services bag handed to inner pipelines built by `forEachTask`.
 *
 * A single `RateLimitCoordinator` + `SignalBusPort` pair is shared for the
 * duration of a `forEachTask` step so sibling tasks can coordinate rate-limit
 * pauses and emit observability events into the same stream.
 */
export interface ParallelSharedServices {
  coordinator: RateLimitCoordinatorPort;
  signalBus: SignalBusPort;
}
