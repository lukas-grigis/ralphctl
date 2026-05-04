/**
 * `assertDraftLeaf` — reusable guard leaf that fails the chain when the
 * loaded sprint is not in `draft` status.
 *
 * Surfaces an `InvalidStateError` so the trace clearly shows the
 * precondition that broke. The `attemptedAction` parameter names the
 * workflow that is being blocked (e.g. `'refine'`, `'plan'`, `'ideate'`)
 * so the error message is actionable.
 *
 * Used by every chain that requires a draft sprint before it proceeds.
 */
import { Result } from '@src/domain/result.ts';

import type { Sprint } from '@src/domain/entities/sprint.ts';
import { InvalidStateError } from '@src/domain/errors/invalid-state-error.ts';
import { Leaf } from '@src/kernel/chain/leaf.ts';
import type { Element } from '@src/kernel/chain/element.ts';

/**
 * Build an assert-draft guard leaf.
 *
 * @param attemptedAction — label embedded in the `InvalidStateError` that
 *   identifies which workflow was blocked (e.g. `'refine'`, `'plan'`).
 */
export function assertDraftLeaf<TCtx extends { readonly sprint?: Sprint }>(attemptedAction: string): Element<TCtx> {
  return new Leaf<TCtx, { readonly sprint: Sprint }, void>('assert-draft', {
    useCase: {
      async execute(input) {
        if (input.sprint.status !== 'draft') {
          return Promise.resolve(
            Result.error(
              new InvalidStateError({
                entity: 'sprint',
                currentState: input.sprint.status,
                attemptedAction,
              })
            )
          );
        }
        return Promise.resolve(Result.ok(undefined));
      },
    },
    input: (ctx) => {
      if (!ctx.sprint) {
        throw new Error('assert-draft: ctx.sprint must be loaded first');
      }
      return { sprint: ctx.sprint };
    },
    output: (ctx) => ctx,
  });
}
