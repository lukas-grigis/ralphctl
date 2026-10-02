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
import { sessionHintsFromLaunchResult } from '@src/application/ui/shared/launcher.ts';
import type { LaunchResult } from '@src/application/ui/shared/launcher.ts';
import type { ProjectId } from '@src/domain/value/id/project-id.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';

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

  it('threads pinned project/sprint ids and labels through register', () => {
    const sessions = createSessionManager();
    const flow: Element<Ctx> = sequential<Ctx>('flow', [okLeaf('one')]);
    const runner = createRunner({ id: 'r-pinned', element: flow, initialCtx: {} });

    sessions.register({
      runner,
      flowId: 'implement',
      title: 'Implement',
      pinnedProjectId: 'proj-1' as ProjectId,
      pinnedProjectLabel: 'My Project',
      pinnedSprintId: 'sprint-1' as SprintId,
      pinnedSprintLabel: 'Sprint Alpha',
    });

    const record = sessions.get('r-pinned');
    expect(record?.descriptor.pinnedProjectId).toBe('proj-1');
    expect(record?.descriptor.pinnedProjectLabel).toBe('My Project');
    expect(record?.descriptor.pinnedSprintId).toBe('sprint-1');
    expect(record?.descriptor.pinnedSprintLabel).toBe('Sprint Alpha');
  });

  it('leaves pinned fields undefined when not supplied to register', () => {
    const sessions = createSessionManager();
    const flow: Element<Ctx> = sequential<Ctx>('flow', [okLeaf('one')]);
    const runner = createRunner({ id: 'r-no-pinned', element: flow, initialCtx: {} });

    sessions.register({ runner, flowId: 'refine', title: 'Refine' });

    const record = sessions.get('r-no-pinned');
    expect(record?.descriptor.pinnedProjectId).toBeUndefined();
    expect(record?.descriptor.pinnedProjectLabel).toBeUndefined();
    expect(record?.descriptor.pinnedSprintId).toBeUndefined();
    expect(record?.descriptor.pinnedSprintLabel).toBeUndefined();
  });

  it('sessionHintsFromLaunchResult round-trips pinned project/sprint fields', () => {
    const flow: Element<Ctx> = sequential<Ctx>('flow', [okLeaf('one')]);
    const runner = createRunner({ id: 'r-hints', element: flow, initialCtx: {} });

    const result = {
      ok: true as const,
      runner: runner as ReturnType<typeof createRunner>,
      title: 'Implement',
      pinnedProjectId: 'proj-abc' as ProjectId,
      pinnedProjectLabel: 'Test Project',
      pinnedSprintId: 'sprint-xyz' as SprintId,
      pinnedSprintLabel: 'Test Sprint',
    } satisfies Extract<LaunchResult, { ok: true }>;

    const hints = sessionHintsFromLaunchResult(result);

    expect(hints.pinnedProjectId).toBe('proj-abc');
    expect(hints.pinnedProjectLabel).toBe('Test Project');
    expect(hints.pinnedSprintId).toBe('sprint-xyz');
    expect(hints.pinnedSprintLabel).toBe('Test Sprint');
  });

  it('sessionHintsFromLaunchResult omits pinned fields when not set on LaunchResult', () => {
    const flow: Element<Ctx> = sequential<Ctx>('flow', [okLeaf('one')]);
    const runner = createRunner({ id: 'r-no-hints', element: flow, initialCtx: {} });

    const result = {
      ok: true as const,
      runner: runner as ReturnType<typeof createRunner>,
      title: 'Refine',
    } satisfies Extract<LaunchResult, { ok: true }>;

    const hints = sessionHintsFromLaunchResult(result);

    expect(hints.pinnedProjectId).toBeUndefined();
    expect(hints.pinnedProjectLabel).toBeUndefined();
    expect(hints.pinnedSprintId).toBeUndefined();
    expect(hints.pinnedSprintLabel).toBeUndefined();
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

    it('emergency-bounds the map by shedding the oldest RUNNING records past the hard ceiling', () => {
      const RUNNING_CEILING = 200;
      const clock = makeFakeClock();
      const sessions = createSessionManager({ clock: clock.now });

      // Register well past the ceiling, one ms apart so startedAt ordering is deterministic. The
      // emergency tier fires on each register()'s pre-insert sweep, keeping the map bounded (at most
      // ceiling + 1: one fresh insert can sit above the cap until the next sweep) instead of growing
      // unboundedly with never-terminating runs (the leak pathology).
      const total = RUNNING_CEILING + 25;
      for (let i = 0; i < total; i++) {
        registerRunning(sessions, `live-${i}`);
        clock.advance(1);
      }

      // Map is bounded — the running overflow was shed, not retained.
      expect(sessions.list().length).toBeLessThanOrEqual(RUNNING_CEILING + 1);
      // The oldest running records were the ones shed; the newest survive.
      expect(sessions.get('live-0')).toBeUndefined();
      expect(sessions.get(`live-${total - 1}`)).toBeDefined();
    });
  });

  describe('terminal memory hygiene', () => {
    it('drops the heavy runner ctx reference on the terminal transition (keeps trace + status)', async () => {
      const sessions = createSessionManager();
      const flow: Element<Ctx> = sequential<Ctx>('flow', [okLeaf('one')]);
      const runner = createRunner({ id: 'r-ctx', element: flow, initialCtx: {} });

      sessions.register({ runner, flowId: 'implement', title: 'Implement' });
      await runner.start();

      const rec = sessions.get('r-ctx');
      expect(rec?.descriptor.status).toBe('completed');
      // The record's runner is now a terminal stub: it no longer holds the live ctx, but the
      // trace + identity the UI reads survive.
      expect(rec?.runner.ctx).toBeUndefined();
      expect(rec?.runner.id).toBe('r-ctx');
      expect(rec?.runner.trace).toBe(rec?.descriptor.trace);
      // abort() on a terminal stub is a no-op (never throws).
      expect(() => rec?.runner.abort()).not.toThrow();
    });

    it('shedTerminal drops every terminal record and leaves running ones untouched', async () => {
      const sessions = createSessionManager();

      // Two terminal runs.
      for (const id of ['done-1', 'done-2']) {
        const r = createRunner({ id, element: sequential<Ctx>(id, [okLeaf('one')]), initialCtx: {} });
        sessions.register({ runner: r, flowId: 'demo', title: id });
        await r.start();
      }
      // One running run (never started → stays non-terminal).
      const live = createRunner({ id: 'live', element: sequential<Ctx>('live', [okLeaf('one')]), initialCtx: {} });
      sessions.register({ runner: live, flowId: 'demo', title: 'live' });

      const dropped = sessions.shedTerminal();
      expect(dropped).toBe(2);
      expect(sessions.get('done-1')).toBeUndefined();
      expect(sessions.get('done-2')).toBeUndefined();
      expect(sessions.get('live')).toBeDefined();
    });
  });
});
