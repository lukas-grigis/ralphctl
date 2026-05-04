import { Result } from 'typescript-result';

import type { ChainTraceEntry, ElementResult, KernelError, OnCtxUpdateCallback, OnTraceCallback } from './element.ts';
import { Element } from './element.ts';

/** Configuration for an {@link OnError}. */
export interface OnErrorConfig<TCtx> {
  /** Element to run when the wrapped element fails (and `catchIf` matches). */
  readonly fallback: Element<TCtx>;
  /**
   * Decide whether a given error should be caught. Defaults to "catch
   * everything" if omitted. If the predicate returns false, the original
   * error propagates unchanged with the original trace.
   */
  readonly catchIf?: (err: KernelError) => boolean;
}

/**
 * Catch + fallback decorator.
 *
 * Wraps a single element. On failure:
 * - If `catchIf(err)` returns true (or `catchIf` is omitted), runs `fallback`
 *   with the SAME input context. The fallback's result becomes the wrapper's
 *   result; the trace contains the failed child's entries followed by the
 *   fallback's entries.
 * - Otherwise propagates the original error and trace unchanged.
 *
 * Errors from the fallback itself propagate (i.e. the wrapper does not
 * recursively catch).
 */
export class OnError<TCtx> extends Element<TCtx> {
  private readonly child: Element<TCtx>;
  private readonly config: OnErrorConfig<TCtx>;

  constructor(child: Element<TCtx>, config: OnErrorConfig<TCtx>) {
    super(child.name);
    this.child = child;
    this.config = config;
  }

  protected override async run(
    ctx: TCtx,
    signal?: AbortSignal,
    onTrace?: OnTraceCallback,
    onCtxUpdate?: OnCtxUpdateCallback<TCtx>
  ): Promise<ElementResult<TCtx>> {
    const childResult = await this.child.execute(ctx, signal, onTrace, onCtxUpdate);
    if (childResult.ok) return childResult;

    const matches = this.config.catchIf ? this.config.catchIf(childResult.error.error) : true;
    if (!matches) return childResult;

    const trace: ChainTraceEntry[] = [...childResult.error.trace];
    const fallbackResult = await this.config.fallback.execute(ctx, signal, onTrace, onCtxUpdate);
    if (fallbackResult.ok) {
      trace.push(...fallbackResult.value.trace);
      return Result.ok({ ctx: fallbackResult.value.ctx, trace });
    }
    trace.push(...fallbackResult.error.trace);
    return Result.error({ error: fallbackResult.error.error, trace });
  }
}
