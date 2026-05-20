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

  describe('eviction', () => {
    const TTL_MS = 30 * 60 * 1000;
    const LRU_CAP = 50;

    const makeFakeClock = (start = 1_000_000): { now: () => number; advance: (ms: number) => void } => {
      let t = start;
      return {
        now: () => t,
        advance: (ms) => {
          t += ms;
        },
      };
    };

    const registerTerminal = async (sessions: ReturnType<typeof createSessionManager>, id: string): Promise<void> => {
      const flow: Element<Ctx> = sequential<Ctx>(id, [okLeaf('one')]);
      const runner = createRunner({ id, element: flow, initialCtx: {} });
      await runner.start();
      sessions.register({ runner, flowId: 'demo', title: id });
    };

    const registerRunning = (sessions: ReturnType<typeof createSessionManager>, id: string): void => {
      const flow: Element<Ctx> = sequential<Ctx>(id, [okLeaf('one')]);
      const runner = createRunner({ id, element: flow, initialCtx: {} });
      // Do not start — runner stays in 'idle' (non-terminal), which `evict` treats the same as
      // 'running': protected from both TTL and LRU pressure.
      sessions.register({ runner, flowId: 'demo', title: id });
    };

    it('evicts terminal records older than the TTL on the next sweep', async () => {
      const clock = makeFakeClock();
      const sessions = createSessionManager({ clock: clock.now });
      await registerTerminal(sessions, 'old');
      expect(sessions.get('old')).toBeDefined();

      clock.advance(TTL_MS + 1);
      // A second register() triggers the eviction sweep.
      await registerTerminal(sessions, 'new');

      expect(sessions.get('old')).toBeUndefined();
      expect(sessions.get('new')).toBeDefined();
    });

    it('retains terminal records under the TTL', async () => {
      const clock = makeFakeClock();
      const sessions = createSessionManager({ clock: clock.now });
      await registerTerminal(sessions, 'fresh');

      clock.advance(TTL_MS - 1);
      await registerTerminal(sessions, 'next');

      expect(sessions.get('fresh')).toBeDefined();
      expect(sessions.get('next')).toBeDefined();
    });

    it('never evicts non-terminal records regardless of age', async () => {
      const clock = makeFakeClock();
      const sessions = createSessionManager({ clock: clock.now });
      registerRunning(sessions, 'live');

      clock.advance(TTL_MS * 10);
      // Sweep fires inside register() — `live` is non-terminal so it must survive.
      await registerTerminal(sessions, 'tick');

      expect(sessions.get('live')).toBeDefined();
    });

    it('drops the oldest terminal record when more than LRU_CAP terminals exist', async () => {
      const clock = makeFakeClock();
      const sessions = createSessionManager({ clock: clock.now });

      // Fill exactly to cap: 50 terminal records, each finished a millisecond apart so ordering
      // by finishedAt is deterministic.
      for (let i = 0; i < LRU_CAP; i++) {
        await registerTerminal(sessions, `t-${i}`);
        clock.advance(1);
      }
      expect(sessions.list().length).toBe(LRU_CAP);

      // 51st terminal record. The next register() runs evict() *before* inserting, which sees
      // size === LRU_CAP (under cap), so nothing drops yet. After insertion the runner finishes
      // and `update()` re-runs evict() with size === LRU_CAP + 1 → oldest terminal goes.
      await registerTerminal(sessions, 'overflow');

      expect(sessions.list().length).toBe(LRU_CAP);
      expect(sessions.get('t-0')).toBeUndefined();
      expect(sessions.get('overflow')).toBeDefined();
    });

    it('does not evict when running records push size above LRU_CAP', () => {
      const clock = makeFakeClock();
      const sessions = createSessionManager({ clock: clock.now });

      for (let i = 0; i < LRU_CAP + 5; i++) {
        registerRunning(sessions, `r-${i}`);
      }

      expect(sessions.list().length).toBe(LRU_CAP + 5);
      // Every running record still present — none can be displaced.
      for (let i = 0; i < LRU_CAP + 5; i++) {
        expect(sessions.get(`r-${i}`)).toBeDefined();
      }
    });
  });
});
