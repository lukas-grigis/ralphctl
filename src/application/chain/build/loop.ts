import { Result } from '@src/domain/result.ts';

import { checkAborted, displayMeta, type Element, type ElementResult } from '@src/application/chain/element.ts';
import {
  abortedEntry,
  type LoopIteration,
  type OnStart,
  type OnTrace,
  type TraceEntry,
} from '@src/application/chain/trace.ts';

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
  /**
   * Iteration cap shown by the step display when the real bound lives elsewhere (a `shouldContinue`
   * predicate). Display-only: never bounds execution, and ignored when `maxIterations` is set.
   */
  readonly displayMaxIterations?: number;
  /** Display label for the loop's iteration rows. */
  readonly label?: string;
  /** Bookkeeping loop — hidden from the step display unless it fails or runs. */
  readonly internal?: boolean;
}

/** Prepend this loop's iteration so nested stamps read outer-first (inner loops stamp first). */
const stampWith =
  (iteration: LoopIteration) =>
  <T extends { readonly iterations?: readonly LoopIteration[] }>(item: T): T => ({
    ...item,
    iterations: [iteration, ...(item.iterations ?? [])],
  });

const DEFAULT_MAX_ITERATIONS = 1000;

const displayCap = <TCtx>(opts: LoopOptions<TCtx>): { readonly maxIterations?: number } => {
  const cap = opts.maxIterations ?? opts.displayMaxIterations;
  return cap !== undefined ? { maxIterations: cap } : {};
};

export const loop = <TCtx>(name: string, body: Element<TCtx>, opts: LoopOptions<TCtx> = {}): Element<TCtx> => {
  // Normalise the optional predicates once, at construction. An omitted `shouldContinue` means
  // "never exit early" and an omitted `shouldStop` means "never stop after the body", so the
  // iteration below can call both unconditionally.
  const shouldContinue = opts.shouldContinue ?? ((): boolean => true);
  const shouldStop = opts.shouldStop ?? ((): boolean => false);
  const max = opts.maxIterations ?? DEFAULT_MAX_ITERATIONS;

  return {
    name,
    kind: 'loop',
    ...displayMeta({ label: opts.label, internal: opts.internal }),
    ...displayCap(opts),
    children: [body],
    async execute(ctx, signal, onTrace, onStart): Promise<ElementResult<TCtx>> {
      const aborted = checkAborted<TCtx>(name, signal, onTrace);
      if (aborted) return aborted;

      const trace: TraceEntry[] = [];
      let currentCtx = ctx;

      for (let i = 1; i <= max; i++) {
        if (signal?.aborted) {
          const entry = abortedEntry(name);
          trace.push(entry);
          onTrace?.(entry);
          return Result.error({ error: entry.error, trace });
        }

        if (!(await shouldContinue(currentCtx, i))) return Result.ok({ ctx: currentCtx, trace });

        // The returned trace is stamped the same way as the forwarded one so the two stay equal.
        const stamp = stampWith({ loop: name, n: i });
        const stampedTrace: OnTrace | undefined = onTrace && ((e) => onTrace(stamp(e)));
        const stampedStart: OnStart | undefined = onStart && ((s) => onStart(stamp(s)));
        const result = await body.execute(currentCtx, signal, stampedTrace, stampedStart);
        if (!result.ok) {
          trace.push(...result.error.trace.map(stamp));
          return Result.error({ error: result.error.error, trace });
        }
        trace.push(...result.value.trace.map(stamp));
        currentCtx = result.value.ctx;

        if (await shouldStop(currentCtx, i)) return Result.ok({ ctx: currentCtx, trace });
      }

      return Result.ok({ ctx: currentCtx, trace });
    },
  };
};
