import { Result } from '@src/domain/result.ts';

import {
  checkAborted,
  displayMeta,
  type CompositeOpts,
  type Element,
  type ElementResult,
} from '@src/application/chain/element.ts';
import { skippedEntry, type TraceEntry } from '@src/application/chain/trace.ts';

export const guard = <TCtx>(
  name: string,
  predicate: (ctx: TCtx) => boolean,
  body: Element<TCtx>,
  opts?: CompositeOpts
): Element<TCtx> => ({
  name,
  kind: 'guard',
  ...displayMeta({ label: opts?.label, internal: opts?.internal, workItem: opts?.workItem }),
  children: [body],
  async execute(ctx, signal, onTrace, onStart): Promise<ElementResult<TCtx>> {
    const aborted = checkAborted<TCtx>(name, signal, onTrace);
    if (aborted) return aborted;

    if (!predicate(ctx)) {
      const entry: TraceEntry = skippedEntry(body.name);
      onTrace?.(entry);
      return Result.ok({ ctx, trace: [entry] });
    }
    return body.execute(ctx, signal, onTrace, onStart);
  },
});
