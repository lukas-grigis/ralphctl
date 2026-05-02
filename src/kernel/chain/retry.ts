import { Result } from 'typescript-result';

import type { ChainTraceEntry, ElementResult, KernelError, OnTraceCallback } from './element.ts';
import { Element } from './element.ts';

export type RetryBackoff = 'fixed' | 'exponential';

/** Configuration for a {@link Retry}. */
export interface RetryConfig {
  /** Total attempts including the first. Must be >= 1. */
  readonly maxAttempts: number;
  readonly backoff: RetryBackoff;
  /** Base delay between attempts in milliseconds. */
  readonly initialDelayMs: number;
  /** Predicate: should this error trigger another attempt? */
  readonly retryOn: (err: KernelError) => boolean;
}

/**
 * Retry a single child element on failure.
 *
 * Each attempt produces its own trace entry, named `{child.name}#attempt-N`,
 * so the trace shows the full retry history. The wrapper itself is invisible
 * in the trace — what matters is which underlying step failed and how many
 * times.
 *
 * Backoff:
 * - `'fixed'`: every gap is `initialDelayMs`.
 * - `'exponential'`: gap N is `initialDelayMs * 2^(N-1)` (so N=1 → initial,
 *   N=2 → 2×initial, N=3 → 4×initial …).
 *
 * Aborts are honoured: if the signal fires during a backoff delay or before
 * the next attempt, retry stops immediately and the in-flight attempt's
 * outcome (or a synthetic aborted entry for the not-yet-started attempt) is
 * the last trace entry.
 */
export class Retry<TCtx> extends Element<TCtx> {
  private readonly child: Element<TCtx>;
  private readonly config: RetryConfig;

  constructor(child: Element<TCtx>, config: RetryConfig) {
    super(child.name);
    if (config.maxAttempts < 1) {
      throw new Error(`Retry('${child.name}'): maxAttempts must be >= 1, got ${String(config.maxAttempts)}`);
    }
    this.child = child;
    this.config = config;
  }

  protected override async run(
    ctx: TCtx,
    signal?: AbortSignal,
    onTrace?: OnTraceCallback
  ): Promise<ElementResult<TCtx>> {
    const trace: ChainTraceEntry[] = [];
    let lastError: KernelError | null = null;

    for (let attempt = 1; attempt <= this.config.maxAttempts; attempt++) {
      if (signal?.aborted) {
        const abortErr: KernelError = { code: 'aborted', message: 'Operation aborted' };
        const entry: ChainTraceEntry = {
          stepName: `${this.child.name}#attempt-${String(attempt)}`,
          status: 'aborted' as const,
          durationMs: 0,
          error: abortErr,
        };
        trace.push(entry);
        onTrace?.(entry);
        return Result.error({ error: abortErr, trace });
      }

      // Re-label child entries on the fly with the attempt suffix so the
      // live stream matches what ends up in the final trace.
      const attemptOnTrace: OnTraceCallback | undefined = onTrace
        ? (entry) => {
            onTrace({ ...entry, stepName: `${entry.stepName}#attempt-${String(attempt)}` });
          }
        : undefined;

      const result = await this.child.execute(ctx, signal, attemptOnTrace);
      const childTrace = result.ok ? result.value.trace : result.error.trace;
      // Re-label the child's own trace entries with the attempt suffix so
      // the trace clearly shows which attempt produced which entry.
      for (const entry of childTrace) {
        trace.push({ ...entry, stepName: `${entry.stepName}#attempt-${String(attempt)}` });
      }

      if (result.ok) {
        return Result.ok({ ctx: result.value.ctx, trace });
      }

      lastError = result.error.error;

      const isLastAttempt = attempt === this.config.maxAttempts;
      const shouldRetry = !isLastAttempt && this.config.retryOn(lastError);
      if (!shouldRetry) break;

      const delayMs = this.computeDelay(attempt);
      if (delayMs > 0) {
        const aborted = await sleep(delayMs, signal);
        if (aborted) {
          const abortErr: KernelError = { code: 'aborted', message: 'Operation aborted' };
          const entry: ChainTraceEntry = {
            stepName: `${this.child.name}#attempt-${String(attempt + 1)}`,
            status: 'aborted' as const,
            durationMs: 0,
            error: abortErr,
          };
          trace.push(entry);
          onTrace?.(entry);
          return Result.error({ error: abortErr, trace });
        }
      }
    }

    return Result.error({
      error: lastError ?? { code: 'retry-exhausted', message: 'Retry exhausted with no error recorded' },
      trace,
    });
  }

  private computeDelay(attempt: number): number {
    if (this.config.backoff === 'fixed') return this.config.initialDelayMs;
    return this.config.initialDelayMs * 2 ** (attempt - 1);
  }
}

/**
 * Abort-aware setTimeout. Resolves `true` if aborted, `false` if the timer
 * fires normally.
 */
function sleep(ms: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    if (signal?.aborted) {
      resolve(true);
      return;
    }
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve(false);
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}
