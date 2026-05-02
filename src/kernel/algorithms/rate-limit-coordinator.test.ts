import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RateLimitEvent } from './rate-limit-coordinator.ts';
import { RateLimitCoordinator } from './rate-limit-coordinator.ts';

describe('RateLimitCoordinator', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {
      /* swallow expected warnings from listener-throw test */
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('starts unpaused', () => {
    const coord = new RateLimitCoordinator();
    expect(coord.isPaused()).toBe(false);
  });

  it('pause() flips state and notifies subscribers with reason + resumeAt', () => {
    const coord = new RateLimitCoordinator();
    const events: RateLimitEvent[] = [];
    coord.subscribe((e) => events.push(e));

    const resumeAt = new Date(Date.now() + 60_000);
    coord.pause('429 from upstream', resumeAt);

    expect(coord.isPaused()).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0]).toStrictEqual({ type: 'paused', reason: '429 from upstream', resumeAt });
  });

  it('pause() while already paused replaces reason and re-notifies', () => {
    const coord = new RateLimitCoordinator();
    const events: RateLimitEvent[] = [];
    coord.subscribe((e) => events.push(e));

    coord.pause('first');
    coord.pause('second');

    expect(events).toHaveLength(2);
    expect(events[1]).toStrictEqual({ type: 'paused', reason: 'second' });
  });

  it('resume() flips state and notifies', () => {
    const coord = new RateLimitCoordinator();
    coord.pause('rate limited');

    const events: RateLimitEvent[] = [];
    coord.subscribe((e) => events.push(e));

    coord.resume();

    expect(coord.isPaused()).toBe(false);
    expect(events).toStrictEqual([{ type: 'resumed' }]);
  });

  it('resume() while already running is a no-op', () => {
    const coord = new RateLimitCoordinator();
    const events: RateLimitEvent[] = [];
    coord.subscribe((e) => events.push(e));

    coord.resume();
    expect(events).toHaveLength(0);
  });

  it('waitUntilResumed() resolves immediately when not paused', async () => {
    const coord = new RateLimitCoordinator();
    await expect(coord.waitUntilResumed()).resolves.toBeUndefined();
  });

  it('waitUntilResumed() blocks while paused and resolves on resume', async () => {
    const coord = new RateLimitCoordinator();
    coord.pause('paused');

    let resolved = false;
    const promise = coord.waitUntilResumed().then(() => {
      resolved = true;
    });

    // Yield once: still paused, waiter shouldn't have resolved.
    await Promise.resolve();
    expect(resolved).toBe(false);

    coord.resume();
    await promise;
    expect(resolved).toBe(true);
  });

  it('waitUntilResumed() resolves all stacked waiters at once', async () => {
    const coord = new RateLimitCoordinator();
    coord.pause('paused');

    const w1 = coord.waitUntilResumed();
    const w2 = coord.waitUntilResumed();
    const w3 = coord.waitUntilResumed();

    coord.resume();
    await expect(Promise.all([w1, w2, w3])).resolves.toStrictEqual([undefined, undefined, undefined]);
  });

  it('waitUntilResumed() rejects when signal is already aborted', async () => {
    const coord = new RateLimitCoordinator();
    coord.pause('paused');
    const ac = new AbortController();
    ac.abort('cancelled');
    await expect(coord.waitUntilResumed(ac.signal)).rejects.toBe('cancelled');
  });

  it('waitUntilResumed() rejects when signal aborts mid-wait', async () => {
    const coord = new RateLimitCoordinator();
    coord.pause('paused');
    const ac = new AbortController();
    const promise = coord.waitUntilResumed(ac.signal);

    ac.abort('cancelled mid-wait');
    await expect(promise).rejects.toBe('cancelled mid-wait');

    // A subsequent resume must not double-settle the rejected promise.
    expect(() => {
      coord.resume();
    }).not.toThrow();
  });

  it('subscribe returns an unsubscribe that stops further notifications', () => {
    const coord = new RateLimitCoordinator();
    const events: RateLimitEvent[] = [];
    const unsubscribe = coord.subscribe((e) => events.push(e));

    coord.pause('first');
    expect(events).toHaveLength(1);

    unsubscribe();
    coord.resume();
    coord.pause('second');
    expect(events).toHaveLength(1);
  });

  it('one listener throwing does not stall delivery to others', () => {
    const coord = new RateLimitCoordinator();
    const seen: string[] = [];
    coord.subscribe(() => {
      seen.push('a');
      throw new Error('listener-a boom');
    });
    coord.subscribe((e) => {
      seen.push(`b:${e.type}`);
    });
    coord.subscribe((e) => {
      seen.push(`c:${e.type}`);
    });

    coord.pause('test');
    expect(seen).toStrictEqual(['a', 'b:paused', 'c:paused']);
  });
});
