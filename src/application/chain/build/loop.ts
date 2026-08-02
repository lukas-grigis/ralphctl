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

const DEFAULT_MAX_ITERATIONS = 1000;

export const loop = <TCtx>(name: string, body: Element<TCtx>, opts: LoopOptions<TCtx> = {}): Element<TCtx> => {
  // Normalise the optional predicates once, at construction. An omitted `shouldContinue` means
  // "never exit early" and an omitted `shouldStop` means "never stop after the body", so the
  // iteration below can call both unconditionally.
  const shouldContinue = opts.shouldContinue ?? ((): boolean => true);
  const shouldStop = opts.shouldStop ?? ((): boolean => false);
  const max = opts.maxIterations ?? DEFAULT_MAX_ITERATIONS;

  return {
    name,
    children: [body],
    async execute(ctx, signal, onTrace): Promise<ElementResult<TCtx>> {
      const aborted = checkAborted<TCtx>(name, signal, onTrace);
      if (aborted) return aborted;

      const trace: TraceEntry[] = [];
      let currentCtx = ctx;

      for (let i = 1; i <= max; i++) {
        if (signal?.aborted) {
          const entry = abortedEntry(name);
          trace.push(entry);
          onTrace?.(entry);
          return Result.error({ error: entry.error!, trace });
        }

        if (!(await shouldContinue(currentCtx, i))) return Result.ok({ ctx: currentCtx, trace });

        const result = await body.execute(currentCtx, signal, onTrace);
        if (!result.ok) {
          trace.push(...result.error.trace);
          return Result.error({ error: result.error.error, trace });
        }
        trace.push(...result.value.trace);
        currentCtx = result.value.ctx;

        if (await shouldStop(currentCtx, i)) return Result.ok({ ctx: currentCtx, trace });
      }

      return Result.ok({ ctx: currentCtx, trace });
    },
  };
};
