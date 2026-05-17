/**
 * Session-manager listener hygiene. Critical for long TUI sessions that run multiple Implement
 * chains back-to-back — without auto-detach on terminal, every dead runner leaves a permanent
 * listener pinning its trace buffer.
 *
 * The runner does not expose its listener Set directly. We assert hygiene indirectly: count
 * how many times the session-manager's own notify fires. If the manager's listener detached
 * cleanly, a late-subscriber replay (which fires the runner's listeners synchronously) will
 * NOT re-run the manager's handler chain — so notify count stays put.
 */

import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';
import { sequential } from '@src/application/chain/build/sequential.ts';
import { createRunner } from '@src/application/chain/run/runner.ts';
import { createSessionManager } from '@src/application/ui/tui/runtime/session-manager.ts';

interface Ctx {
  readonly _?: never;
}
const okLeaf = (name: string): Element<Ctx> =>
  leaf<Ctx, void, void>(name, {
    useCase: { execute: async () => Result.ok(undefined) },
    input: () => undefined,
    output: (ctx) => ctx,
  });

describe('session-manager', () => {
  it('detaches its runner listener after the run reaches terminal', async () => {
    const sessions = createSessionManager();
    let notifyCount = 0;
    sessions.subscribe(() => {
      notifyCount++;
    });

    const flow: Element<Ctx> = sequential<Ctx>('flow', [okLeaf('one')]);
    const runner = createRunner({ id: 'r-1', element: flow, initialCtx: {} });
    sessions.register({ runner, flowId: 'demo', title: 'Demo' });

    await runner.start();
    const countAfterRun = notifyCount;
    expect(countAfterRun).toBeGreaterThan(0);

    // Late subscriber: triggers runner.replayTo(listener), which synchronously fires every
    // step + the terminal event. If session-manager were still attached, its handler would
    // run for each replayed event and call update→notify. We assert that didn't happen.
    runner.subscribe(() => undefined);
    expect(notifyCount).toBe(countAfterRun);
  });

  it('handles the sync-replay case when registering an already-terminal runner', async () => {
    // Pre-complete the runner BEFORE register — the listener fires synchronously during
    // subscribe(), and `pendingDetach` must still finalise the detach after subscribe returns.
    const sessions = createSessionManager();
    let notifyCount = 0;
    sessions.subscribe(() => {
      notifyCount++;
    });

    const flow: Element<Ctx> = sequential<Ctx>('flow', [okLeaf('one')]);
    const runner = createRunner({ id: 'r-2', element: flow, initialCtx: {} });
    await runner.start();

    sessions.register({ runner, flowId: 'demo', title: 'Demo' });
    const countAfterRegister = notifyCount;
    expect(countAfterRegister).toBeGreaterThan(0);

    // Late subscriber replays — manager must already be detached.
    runner.subscribe(() => undefined);
    expect(notifyCount).toBe(countAfterRegister);
  });
});
