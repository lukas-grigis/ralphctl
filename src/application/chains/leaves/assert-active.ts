/**
 * `assertActiveLeaf` — reusable guard leaf that fails the chain when the
 * loaded sprint is not in `active` status.
 *
 * Surfaces an `InvalidStateError` so the trace clearly shows the
 * precondition that broke. The `attemptedAction` parameter names the
 * workflow that is being blocked (e.g. `'execute'`, `'evaluate'`,
 * `'feedback'`, `'create-pr'`) so the error message is actionable. An
 * optional `message` overrides the default error text when callers want
 * a more directive repair hint.
 *
 * Used by every chain that requires an active sprint before it proceeds.
 */
import { Result } from '@src/domain/result.ts';

import type { Sprint } from '@src/domain/entities/sprint.ts';
import { InvalidStateError } from '@src/domain/errors/invalid-state-error.ts';
import { Leaf } from '@src/kernel/chain/leaf.ts';
import type { Element } from '@src/kernel/chain/element.ts';

/**
 * Build an assert-active guard leaf.
 *
 * @param attemptedAction — label embedded in the `InvalidStateError` that
 *   identifies which workflow was blocked (e.g. `'execute'`, `'evaluate'`).
 * @param message — optional override for the default error message.
 */
export function assertActiveLeaf<TCtx extends { readonly sprint?: Sprint }>(
  attemptedAction: string,
  message?: string
): Element<TCtx> {
  return new Leaf<TCtx, { readonly sprint: Sprint }, void>('assert-active', {
    useCase: {
      async execute(input) {
        if (input.sprint.status !== 'active') {
          return Promise.resolve(
            Result.error(
              new InvalidStateError({
                entity: 'sprint',
                currentState: input.sprint.status,
                attemptedAction,
                ...(message !== undefined ? { message } : {}),
              })
            )
          );
        }
        return Promise.resolve(Result.ok(undefined));
      },
    },
    input: (ctx) => {
      if (!ctx.sprint) {
        throw new Error('assert-active: ctx.sprint must be loaded first');
      }
      return { sprint: ctx.sprint };
    },
    output: (ctx) => ctx,
  });
}
