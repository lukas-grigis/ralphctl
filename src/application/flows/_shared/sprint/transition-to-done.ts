import {
  transitionSprintToDoneUseCase,
  type TransitionSprintToDoneProps,
} from '@src/business/sprint/transition-sprint-to-done.ts';
import type { DoneSprint, Sprint } from '@src/domain/entity/sprint.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';
import { assertCtxField } from '@src/application/flows/_shared/_engine/assert-ctx-field.ts';

/**
 * Minimum context shape the leaf reads. `aborted` is optional — `transitionSprintToDoneUseCase`
 * defaults a missing flag to `false` (no abort), which matches the close-sprint flow where the
 * user explicitly asked to close (no review round to abort).
 */
export interface TransitionSprintToDoneCtx {
  readonly sprint?: Sprint;
  readonly aborted?: boolean;
}

/**
 * Reusable leaf — adapts `ctx.{sprint, aborted}` → `transitionSprintToDoneUseCase` → updated
 * ctx. Business policy (review → done transition; idempotent skip when aborted; sprint persisted
 * inside the use case) lives in `@src/business/sprint/transition-sprint-to-done.ts`.
 *
 * Generic over `<TCtx extends TransitionSprintToDoneCtx>` so any flow whose context carries
 * `sprint` + `aborted` can compose it (the review flow's full chain; the close-sprint flow's
 * one-shot close). Returns the ctx unchanged on the aborted branch — saving is internal to the
 * use case, no separate save-leaf needed downstream.
 */
export type TransitionSprintToDoneLeafDeps = Omit<TransitionSprintToDoneProps, 'sprint' | 'aborted'>;

export const transitionSprintToDoneLeaf = <TCtx extends TransitionSprintToDoneCtx>(
  deps: TransitionSprintToDoneLeafDeps,
  name = 'transition-sprint-to-done'
): Element<TCtx> =>
  leaf<TCtx, { readonly sprint: Sprint; readonly aborted: boolean }, DoneSprint | undefined>(name, {
    useCase: {
      execute: async ({ sprint, aborted }) => transitionSprintToDoneUseCase({ ...deps, sprint, aborted }),
    },
    input: (ctx) => {
      const sprint = assertCtxField(ctx, 'sprint', name);
      return { sprint, aborted: ctx.aborted ?? false };
    },
    output: (ctx, sprint) => (sprint !== undefined ? { ...ctx, sprint } : ctx),
  });
