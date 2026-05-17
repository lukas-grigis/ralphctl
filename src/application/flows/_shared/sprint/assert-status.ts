import { Result } from '@src/domain/result.ts';
import { assertSprintStatus, type Sprint, type SprintStatus } from '@src/domain/entity/sprint.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';

/** Minimum context shape the leaf reads. The sprint must already be loaded. */
export interface AssertSprintStatusCtx {
  readonly sprint?: Sprint | undefined;
}

/**
 * Parameterised guard leaf — fails the chain unless the loaded sprint is in one of `allowed`.
 * Replaces per-flow `assertDraftLeaf` / `assertActiveLeaf` variants with a single shared form;
 * each flow passes its own status set.
 *
 * Generic over `<TCtx extends AssertSprintStatusCtx>` so any chain whose context carries a
 * loaded `sprint` can reuse the leaf. The default name is `'assert-sprint-status'`; flows that
 * want a more specific trace name pass it explicitly (e.g. `'assert-draft'`).
 */
export const assertSprintStatusLeaf = <TCtx extends AssertSprintStatusCtx>(
  allowed: readonly SprintStatus[],
  name = 'assert-sprint-status'
): Element<TCtx> =>
  leaf<TCtx, Sprint, void>(name, {
    useCase: {
      execute: async (sprint) => {
        const checked = assertSprintStatus(sprint, allowed, name);
        if (!checked.ok) return Result.error(checked.error);
        return Result.ok(undefined);
      },
    },
    input: (ctx) => {
      if (ctx.sprint === undefined) {
        throw new InvalidStateError({
          entity: 'chain',
          currentState: `pre-${name}`,
          attemptedAction: name,
          message: `${name}: ctx.sprint is undefined — a load-sprint leaf must run before ${name}`,
        });
      }
      return ctx.sprint;
    },
    output: (ctx) => ctx,
  });
