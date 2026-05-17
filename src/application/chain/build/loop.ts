import { Result } from '@src/domain/result.ts';

import { checkAborted, type Element, type ElementResult } from '@src/application/chain/element.ts';
import { abortedEntry, type TraceEntry } from '@src/application/chain/trace.ts';

export interface LoopOptions<TCtx> {
  /** Pre-iteration check. Returning false exits the loop with the current ctx. */
  readonly shouldContinue?: (ctx: TCtx, iteration: number) => boolean | Promise<boolean>;
  /** Post-iteration check. Returning true exits the loop with the body's ctx. */
  readonly shouldStop?: (ctx: TCtx, iteration: number) => boolean | Promise<boolean>;
  /**
   * Hard cap — defence against runaway loops. Default 1000. Hitting the cap is an **ok-return**
   * (not a failure); callers detect budget-exhausted vs. natural termination via ctx state.
   */
  readonly maxIterations?: number;
}

export const loop = <TCtx>(name: string, body: Element<TCtx>, opts: LoopOptions<TCtx> = {}): Element<TCtx> => ({
  name,
  children: [body],
  async execute(ctx, signal, onTrace): Promise<ElementResult<TCtx>> {
    const aborted = checkAborted<TCtx>(name, signal, onTrace);
    if (aborted) return aborted;

    const max = opts.maxIterations ?? 1000;
    const trace: TraceEntry[] = [];
    let currentCtx = ctx;

    for (let i = 1; i <= max; i++) {
      if (signal?.aborted) {
        const entry = abortedEntry(name);
        trace.push(entry);
        onTrace?.(entry);
        return Result.error({ error: entry.error!, trace });
      }

      if (opts.shouldContinue !== undefined) {
        const cont = await opts.shouldContinue(currentCtx, i);
        if (!cont) return Result.ok({ ctx: currentCtx, trace });
      }

      const result = await body.execute(currentCtx, signal, onTrace);
      if (!result.ok) {
        trace.push(...result.error.trace);
        return Result.error({ error: result.error.error, trace });
      }
      trace.push(...result.value.trace);
      currentCtx = result.value.ctx;

      if (opts.shouldStop !== undefined) {
        const stop = await opts.shouldStop(currentCtx, i);
        if (stop) return Result.ok({ ctx: currentCtx, trace });
      }
    }

    return Result.ok({ ctx: currentCtx, trace });
  },
});
