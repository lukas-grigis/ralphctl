import { Result } from '@src/domain/result.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';
import type { ProgressFileSink } from '@src/integration/observability/sinks/progress-file-sink.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';

/**
 * Terminal leaf — drains the per-flow `progress.md` sink before the chain exits. The sink is
 * fire-and-forget at emit time so `progress.md` can lag behind the live signal stream; awaiting
 * `flush()` here guarantees the file is consistent with everything the implement run emitted
 * before the trace closes.
 *
 * Errors raised by the sink are best-effort — the sink already logs lock-acquisition failures.
 * This leaf treats flush as infallible from the chain's perspective.
 */
export const flushProgressSinkLeaf = (progressSink: ProgressFileSink): Element<ImplementCtx> =>
  leaf<ImplementCtx, void, void>('flush-progress-sink', {
    useCase: {
      execute: async () => {
        await progressSink.flush();
        return Result.ok(undefined);
      },
    },
    input: () => undefined,
    output: (ctx) => ctx,
  });
