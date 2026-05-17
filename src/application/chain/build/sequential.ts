import { Result } from '@src/domain/result.ts';

import { checkAborted, type Element, type ElementResult } from '@src/application/chain/element.ts';
import { abortedEntry, skippedEntry, type TraceEntry } from '@src/application/chain/trace.ts';

export const sequential = <TCtx>(name: string, children: ReadonlyArray<Element<TCtx>>): Element<TCtx> => ({
  name,
  children,
  async execute(ctx, signal, onTrace): Promise<ElementResult<TCtx>> {
    const aborted = checkAborted<TCtx>(name, signal, onTrace);
    if (aborted) return aborted;

    const trace: TraceEntry[] = [];
    let currentCtx = ctx;

    for (let i = 0; i < children.length; i++) {
      const child = children[i]!;

      if (signal?.aborted) {
        const entry = abortedEntry(child.name);
        trace.push(entry);
        onTrace?.(entry);
        for (let j = i + 1; j < children.length; j++) {
          const skipped = skippedEntry(children[j]!.name);
          trace.push(skipped);
          onTrace?.(skipped);
        }
        return Result.error({ error: entry.error!, trace });
      }

      const result = await child.execute(currentCtx, signal, onTrace);
      if (!result.ok) {
        trace.push(...result.error.trace);
        for (let j = i + 1; j < children.length; j++) {
          const skipped = skippedEntry(children[j]!.name);
          trace.push(skipped);
          onTrace?.(skipped);
        }
        return Result.error({ error: result.error.error, trace });
      }

      trace.push(...result.value.trace);
      currentCtx = result.value.ctx;
    }

    return Result.ok({ ctx: currentCtx, trace });
  },
});
