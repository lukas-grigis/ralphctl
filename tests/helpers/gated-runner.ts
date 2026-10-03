/**
 * A real chain runner whose single element blocks until `finish()` — stands in for a long flow run (plan, refine, …)
 * that is in flight in this process.
 */

import { Result } from '@src/domain/result.ts';
import type { Element } from '@src/application/chain/element.ts';
import { createRunner, type Runner } from '@src/application/chain/run/runner.ts';

export interface GatedRunner {
  readonly runner: Runner<object>;
  /** Lets the element return, settling the runner as completed. */
  finish(): void;
}

export const createGatedRunner = (id = 'gated-run'): GatedRunner => {
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => (finish = resolve));
  const element: Element<object> = {
    name: 'gated',
    execute: async (ctx) => {
      await gate;
      return Result.ok({ ctx, trace: [] });
    },
  };
  return { runner: createRunner({ id, element, initialCtx: {} }), finish };
};
