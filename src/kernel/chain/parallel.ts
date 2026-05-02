import { Result } from 'typescript-result';

import type { ChainTrace, ChainTraceEntry, ElementResult, KernelError, OnTraceCallback } from './element.ts';
import { Element } from './element.ts';

export type ParallelFailureMode = 'fail-fast' | 'collect-all';

/** Configuration for a {@link Parallel}. */
export interface ParallelConfig<TCtx> {
  /** Hard cap on simultaneous in-flight children. Must be >= 1. */
  readonly concurrency: number;
  /** Whether to abort siblings on first failure or run everyone to completion. */
  readonly failureMode: ParallelFailureMode;
  /**
   * Combine per-child success outputs into a single context.
   * Caller is responsible for deciding how independent child contexts merge.
   */
  readonly reduce: (childResults: readonly TCtx[]) => TCtx;
}

interface ChildOutcome<TCtx> {
  readonly index: number;
  readonly trace: ChainTrace;
  readonly ok: boolean;
  readonly ctx?: TCtx;
  readonly error?: KernelError;
}

/**
 * Fan-out + join.
 *
 * Each child receives the SAME input context — callers must avoid mutating
 * shared references inside `ctx` (the framework does not deep-clone). On
 * success, per-child output contexts are combined via the user-supplied
 * `reduce` function.
 *
 * `failureMode`:
 * - `'fail-fast'`: the first failing child triggers an internal `AbortController`
 *   chained off the parent signal; siblings see `signal.aborted` and bail.
 * - `'collect-all'`: every child runs to completion regardless. If one or
 *   more failed, the result is a failure carrying the FIRST failure's error
 *   (in completion order) and a trace containing every child's entries.
 *
 * Trace entries are recorded in completion order, not start order.
 */
export class Parallel<TCtx> extends Element<TCtx> {
  private readonly children: readonly Element<TCtx>[];
  private readonly config: ParallelConfig<TCtx>;

  constructor(name: string, children: readonly Element<TCtx>[], config: ParallelConfig<TCtx>) {
    super(name);
    if (config.concurrency < 1) {
      throw new Error(`Parallel('${name}'): concurrency must be >= 1, got ${String(config.concurrency)}`);
    }
    this.children = children;
    this.config = config;
  }

  protected override async run(
    ctx: TCtx,
    signal?: AbortSignal,
    onTrace?: OnTraceCallback
  ): Promise<ElementResult<TCtx>> {
    if (this.children.length === 0) {
      return Result.ok({ ctx: this.config.reduce([]), trace: [] });
    }

    // Internal controller: lets fail-fast cancel siblings without affecting
    // the parent signal. Forward outer aborts in.
    const internal = new AbortController();
    const onParentAbort = (): void => {
      internal.abort();
    };
    if (signal) {
      if (signal.aborted) internal.abort();
      else signal.addEventListener('abort', onParentAbort, { once: true });
    }

    const completionOrder: ChildOutcome<TCtx>[] = [];
    let nextIndex = 0;
    let firstFailure: KernelError | null = null;

    const recordCompletion = (outcome: ChildOutcome<TCtx>): void => {
      completionOrder.push(outcome);
    };

    const worker = async (): Promise<void> => {
      while (nextIndex < this.children.length) {
        const i = nextIndex++;
        const child = this.children[i];
        if (!child) continue;

        // Fail-fast already tripped: synthesise an aborted entry without
        // running the child.
        if (this.config.failureMode === 'fail-fast' && internal.signal.aborted) {
          const abortErr: KernelError = { code: 'aborted', message: 'Operation aborted' };
          const entry: ChainTraceEntry = {
            stepName: child.name,
            status: 'aborted' as const,
            durationMs: 0,
            error: abortErr,
          };
          onTrace?.(entry);
          recordCompletion({
            index: i,
            ok: false,
            error: abortErr,
            trace: [entry],
          });
          continue;
        }

        const result = await child.execute(ctx, internal.signal, onTrace);
        if (result.ok) {
          recordCompletion({
            index: i,
            ok: true,
            ctx: result.value.ctx,
            trace: result.value.trace,
          });
        } else {
          recordCompletion({
            index: i,
            ok: false,
            error: result.error.error,
            trace: result.error.trace,
          });
          if (this.config.failureMode === 'fail-fast' && !internal.signal.aborted) {
            firstFailure ??= result.error.error;
            internal.abort();
          }
        }
      }
    };

    const limit = Math.min(this.config.concurrency, this.children.length);
    const workers: Promise<void>[] = [];
    for (let w = 0; w < limit; w++) workers.push(worker());
    await Promise.all(workers);

    if (signal) signal.removeEventListener('abort', onParentAbort);

    const trace: ChainTraceEntry[] = [];
    const successCtxs: TCtx[] = [];
    let firstErrorByCompletion: KernelError | null = null;

    for (const outcome of completionOrder) {
      trace.push(...outcome.trace);
      if (outcome.ok && outcome.ctx !== undefined) {
        successCtxs.push(outcome.ctx);
      } else if (!outcome.ok && firstErrorByCompletion === null && outcome.error) {
        firstErrorByCompletion = outcome.error;
      }
    }

    // For fail-fast, the trigger error wins. For collect-all, the first error
    // by completion order is reported. ESLint's flow analysis can't see that
    // `firstFailure` is mutated inside the worker closure, so it thinks the
    // LHS of the coalesce is always null — silence that one rule here.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    const reportedError = firstFailure ?? firstErrorByCompletion;

    if (reportedError !== null) {
      if (signal?.aborted) {
        return Result.error({
          error: { code: 'aborted', message: 'Operation aborted' },
          trace,
        });
      }
      return Result.error({ error: reportedError, trace });
    }

    return Result.ok({ ctx: this.config.reduce(successCtxs), trace });
  }
}
