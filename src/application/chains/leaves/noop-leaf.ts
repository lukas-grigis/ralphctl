/**
 * `noopLeaf` — identity Leaf factory used as `OnError` fallbacks.
 *
 * Returns the input context unchanged via `Result.ok`, emits a single trace
 * entry under the supplied step name. Every consumer that needs a soft
 * fallback for `OnError(catchIf, fallback)` shares this implementation —
 * keeping the helper in one place stops the local copies from drifting.
 *
 * Generic over the chain context shape so per-task and outer execute chains
 * (and any future workflow) can reuse it without bespoke wrappers.
 */
import { Result } from '@src/domain/result.ts';
import type { Element, KernelError } from '@src/kernel/chain/element.ts';
import { Leaf } from '@src/kernel/chain/leaf.ts';

export function noopLeaf<TCtx>(name: string): Element<TCtx> {
  return new Leaf<TCtx, TCtx, TCtx>(name, {
    useCase: {
      execute(input) {
        return Promise.resolve(Result.ok(input)) as Promise<Result<TCtx, KernelError>>;
      },
    },
    input: (ctx) => ctx,
    output: (_, ctx) => ctx,
  });
}
