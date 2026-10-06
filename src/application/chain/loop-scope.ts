import { AsyncLocalStorage } from 'node:async_hooks';

import type { LoopIteration } from '@src/application/chain/trace.ts';

/**
 * The loop iterations enclosing the running work, outer-first — the same stamp `loop` puts on trace
 * entries, readable from inside a leaf. Lets an event a leaf publishes name the exact iteration it
 * belongs to, which the trace stamps alone cannot (they are added on the way out).
 */
const storage = new AsyncLocalStorage<readonly LoopIteration[]>();

/** Run `fn` inside one more loop iteration. */
export const runInLoopIteration = <T>(iteration: LoopIteration, fn: () => Promise<T>): Promise<T> =>
  storage.run([...(storage.getStore() ?? []), iteration], fn);

/** Enclosing loop iterations, outer-first; empty outside any loop. */
export const currentLoopIterations = (): readonly LoopIteration[] => storage.getStore() ?? [];
