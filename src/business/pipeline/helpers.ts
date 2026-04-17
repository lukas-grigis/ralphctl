import type { StepContext } from '@src/domain/context.ts';
import { Result } from '@src/domain/types.ts';
import type { DomainResult } from '@src/domain/types.ts';
import { DomainError, SpawnError, StepError } from '@src/domain/errors.ts';
import type { RateLimitCoordinatorPort } from '@src/business/ports/rate-limit-coordinator.ts';
import type { HarnessEvent, SignalBusPort, Unsubscribe } from '@src/business/ports/signal-bus.ts';
import { executePipeline } from './pipeline.ts';
import type { ParallelSharedServices, ParallelStepResult, PipelineDefinition, PipelineStep } from './types.ts';

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
 * Fan out N inner pipelines concurrently over a list of items.
 *
 * Each inner pipeline is built per-item with access to a shared
 * `ParallelSharedServices` bag (single `RateLimitCoordinator` +
 * `SignalBusPort`) that lives only for the duration of this step.
 *
 * The outer `TCtx` must include an optional `parallelResults` field — each
 * per-item settlement is appended there so downstream steps can inspect
 * success/error counts, rate-limit occurrences, etc.
 *
 * Concurrency:
 *   - `concurrencyLimit` — at most N inner pipelines run simultaneously.
 *     Default: unbounded.
 *   - `failFast: true` — abort launching further pipelines on the first
 *     non-rate-limit failure. Running pipelines are awaited (never orphaned),
 *     but pending items are skipped (not recorded).
 *   - `failFast: false` (default) — all items run to settlement; failures
 *     are aggregated in the returned `parallelResults` array.
 *
 * Rate-limit errors (`SpawnError.rateLimited === true`) are surfaced via
 * `isRateLimited: true` and never trigger a fail-fast abort — the outer
 * loop is expected to retry after the coordinator's cooldown.
 *
 * Services lifecycle: `createServices` is called once at step start,
 * `disposeServices` is always called in a `finally` block — including on
 * inner failure or throw.
 */
export function parallelMap<
  TItem,
  TCtx extends StepContext & { parallelResults?: ParallelStepResult<unknown, TCtx>[] },
>(
  name: string,
  itemsFn: (ctx: TCtx) => TItem[],
  buildInnerPipeline: (item: TItem, services: ParallelSharedServices) => PipelineDefinition<TCtx>,
  options?: {
    concurrencyLimit?: number;
    failFast?: boolean;
    createServices?: () => ParallelSharedServices;
    disposeServices?: (services: ParallelSharedServices) => void;
  }
): PipelineStep<TCtx> {
  return step<TCtx>(name, async (ctx): Promise<DomainResult<Partial<TCtx>>> => {
    const items = itemsFn(ctx);
    const failFast = options?.failFast ?? false;
    const concurrencyLimit = options?.concurrencyLimit ?? Infinity;

    if (items.length === 0) {
      const empty: Partial<TCtx> = {
        parallelResults: [] as ParallelStepResult<unknown, TCtx>[],
      } as Partial<TCtx>;
      return Result.ok(empty) as DomainResult<Partial<TCtx>>;
    }

    const services = options?.createServices?.() ?? defaultServices();

    const results: ParallelStepResult<TItem, TCtx>[] = [];
    let aborted = false;

    try {
      // Index-preserving concurrency: each worker pulls the next pending
      // index and runs its item to settlement. This keeps the settlement
      // order stable relative to the input order's dispatch (not completion).
      let nextIndex = 0;
      const settled = new Array<ParallelStepResult<TItem, TCtx> | undefined>(items.length);

      const worker = async (): Promise<void> => {
        for (;;) {
          if (aborted) return;
          const i = nextIndex++;
          if (i >= items.length) return;
          const item = items[i] as TItem;

          const settlement = await settleOne(item, buildInnerPipeline, services, ctx);
          settled[i] = settlement;

          // Real failures (not rate limits) trigger fail-fast abort.
          if (failFast && settlement.error && !settlement.isRateLimited) {
            aborted = true;
            return;
          }
        }
      };

      const workerCount = Math.min(concurrencyLimit, items.length);
      const workers = Array.from({ length: workerCount }, () => worker());
      await Promise.all(workers);

      for (const entry of settled) {
        if (entry !== undefined) results.push(entry);
      }
    } finally {
      if (options?.disposeServices) {
        options.disposeServices(services);
      } else {
        services.coordinator.dispose();
        services.signalBus.dispose();
      }
    }

    // If failFast fired, surface the first non-rate-limit error as the
    // step result so the outer pipeline stops cleanly. Otherwise the step
    // succeeds and callers inspect `parallelResults` themselves.
    if (failFast) {
      const firstError = results.find((r) => r.error && !r.isRateLimited);
      if (firstError?.error) {
        return Result.error(firstError.error);
      }
    }

    const output: Partial<TCtx> = {
      parallelResults: results as ParallelStepResult<unknown, TCtx>[],
    } as Partial<TCtx>;
    return Result.ok(output) as DomainResult<Partial<TCtx>>;
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

async function settleOne<TItem, TCtx extends StepContext>(
  item: TItem,
  buildInnerPipeline: (item: TItem, services: ParallelSharedServices) => PipelineDefinition<TCtx>,
  services: ParallelSharedServices,
  ctx: TCtx
): Promise<ParallelStepResult<TItem, TCtx>> {
  try {
    const inner = buildInnerPipeline(item, services);
    const result = await executePipeline(inner, ctx);

    if (!result.ok) {
      const error = result.error;
      return {
        item,
        context: ctx,
        stepResults: [],
        error,
        isRateLimited: isRateLimitError(error),
      };
    }

    const value = result.value;
    return {
      item,
      context: value.context,
      stepResults: value.stepResults,
      isRateLimited: false,
    };
  } catch (err) {
    const error =
      err instanceof DomainError
        ? err
        : new StepError(
            `Unexpected error in parallel item: ${err instanceof Error ? err.message : String(err)}`,
            'parallelMap',
            err instanceof Error ? err : undefined
          );
    return {
      item,
      context: ctx,
      stepResults: [],
      error,
      isRateLimited: isRateLimitError(error),
    };
  }
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

function isRateLimitError(err: DomainError): boolean {
  return findSpawnError(err)?.rateLimited ?? false;
}

/**
 * Fallback services factory when the caller doesn't provide one. Produces
 * a noop implementation of each port — suitable for tests and any use case
 * that doesn't need live rate-limit coordination or signal emission.
 */
function defaultServices(): ParallelSharedServices {
  return {
    coordinator: new NoopRateLimitCoordinator(),
    signalBus: new NoopSignalBusForParallel(),
  };
}

class NoopRateLimitCoordinator implements RateLimitCoordinatorPort {
  readonly isPaused = false;
  readonly remainingMs = 0;
  pause(_delayMs: number): void {
    /* noop */
    void _delayMs;
  }
  waitIfPaused(): Promise<void> {
    return Promise.resolve();
  }
  dispose(): void {
    /* noop */
  }
}

class NoopSignalBusForParallel implements SignalBusPort {
  emit(_event: HarnessEvent): void {
    /* noop */
    void _event;
  }
  subscribe(_listener: (events: readonly HarnessEvent[]) => void): Unsubscribe {
    void _listener;
    return () => {
      /* noop */
    };
  }
  dispose(): void {
    /* noop */
  }
}
