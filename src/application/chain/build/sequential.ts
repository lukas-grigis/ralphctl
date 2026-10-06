import { Result } from '@src/domain/result.ts';

import {
  checkAborted,
  displayMeta,
  type CompositeOpts,
  type Element,
  type ElementResult,
} from '@src/application/chain/element.ts';
import { abortedEntry, skippedEntry, type TraceEntry } from '@src/application/chain/trace.ts';

export const sequential = <TCtx>(
  name: string,
  children: ReadonlyArray<Element<TCtx>>,
  opts?: CompositeOpts
): Element<TCtx> => ({
  name,
  kind: 'sequential',
  ...displayMeta({ label: opts?.label, internal: opts?.internal, workItem: opts?.workItem }),
  children,
  async execute(ctx, signal, onTrace, onStart): Promise<ElementResult<TCtx>> {
    const aborted = checkAborted<TCtx>(name, signal, onTrace);
    if (aborted) return aborted;

    const trace: TraceEntry[] = [];
    let currentCtx = ctx;
    const skipRest = (from: number): void => {
      for (const c of children.slice(from)) {
        const s = skippedEntry(c.name);
        trace.push(s);
        onTrace?.(s);
      }
    };

    for (let i = 0; i < children.length; i++) {
      const child = children[i]!;

      if (signal?.aborted) {
        const entry = abortedEntry(child.name);
        trace.push(entry);
        onTrace?.(entry);
        skipRest(i + 1);
        return Result.error({ error: entry.error, trace });
      }

      const result = await child.execute(currentCtx, signal, onTrace, onStart);
      if (!result.ok) {
        trace.push(...result.error.trace);
        skipRest(i + 1);
        return Result.error({ error: result.error.error, trace });
      }

      trace.push(...result.value.trace);
      currentCtx = result.value.ctx;
    }

    return Result.ok({ ctx: currentCtx, trace });
  },
});
