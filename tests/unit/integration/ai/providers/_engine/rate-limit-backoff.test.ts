import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_BACKOFF_SCHEDULE,
  JITTER_RATIO,
  applyJitter,
  delayForRetry,
  sleepCancellable,
} from '@src/integration/ai/providers/_engine/rate-limit-backoff.ts';

describe('delayForRetry', () => {
  it('returns 0 for retryIndex < 1 (defensive)', () => {
    expect(delayForRetry(0)).toBe(0);
    expect(delayForRetry(-1)).toBe(0);
  });

  it('returns the matching schedule entry for retryIndex 1..N', () => {
    expect(delayForRetry(1)).toBe(DEFAULT_BACKOFF_SCHEDULE[0]);
    expect(delayForRetry(2)).toBe(DEFAULT_BACKOFF_SCHEDULE[1]);
    expect(delayForRetry(3)).toBe(DEFAULT_BACKOFF_SCHEDULE[2]);
    expect(delayForRetry(4)).toBe(DEFAULT_BACKOFF_SCHEDULE[3]);
  });

  it('clamps to the last entry beyond schedule length (very stubborn quota)', () => {
    const last = DEFAULT_BACKOFF_SCHEDULE[DEFAULT_BACKOFF_SCHEDULE.length - 1];
    expect(delayForRetry(10)).toBe(last);
    expect(delayForRetry(100)).toBe(last);
  });

  it('honours a custom schedule (test-injected override)', () => {
    const custom = [10, 20, 30] as const;
    expect(delayForRetry(1, custom)).toBe(10);
    expect(delayForRetry(2, custom)).toBe(20);
    expect(delayForRetry(3, custom)).toBe(30);
    expect(delayForRetry(99, custom)).toBe(30); // clamped to last
  });

  it('default schedule matches the documented "1m → 5m → 30m → 2h" sequence', () => {
    expect(DEFAULT_BACKOFF_SCHEDULE).toEqual([60_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000]);
  });
});

describe('applyJitter', () => {
  it('passes non-positive delays through unchanged (nothing to disperse)', () => {
    expect(applyJitter(0)).toBe(0);
    expect(applyJitter(-5)).toBe(-5);
  });

  it('is a deterministic function of the injected random source, not live Math.random', () => {
    // random() = 0 → the minimum of the jitter window (delay - spread).
    expect(applyJitter(1000, () => 0)).toBe(1000 - 1000 * JITTER_RATIO);
    // random() = 1 → the maximum of the jitter window (delay + spread). Real Math.random()
    // never returns exactly 1, but the injected fake can, pinning the exact upper bound.
    expect(applyJitter(1000, () => 1)).toBe(1000 + 1000 * JITTER_RATIO);
    // random() = 0.5 → the midpoint, i.e. the unjittered base delay.
    expect(applyJitter(1000, () => 0.5)).toBe(1000);
  });

  it('stays within +/- JITTER_RATIO of the base delay for any random() in [0, 1)', () => {
    const base = 60_000;
    for (const r of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 0.999]) {
      const jittered = applyJitter(base, () => r);
      expect(jittered).toBeGreaterThanOrEqual(base * (1 - JITTER_RATIO));
      expect(jittered).toBeLessThanOrEqual(base * (1 + JITTER_RATIO));
    }
  });

  it('two callers with the SAME base delay disperse when their random() draws differ (the lockstep fix)', () => {
    const base = delayForRetry(1);
    const branchA = applyJitter(base, () => 0.1);
    const branchB = applyJitter(base, () => 0.9);
    expect(branchA).not.toBe(branchB);
  });

  it('defaults to Math.random when no source is injected', () => {
    const spy = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    expect(applyJitter(1000)).toBe(1000);
    spy.mockRestore();
  });
});

describe('sleepCancellable', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves after `ms` when no abort signal is provided', async () => {
    let resolved = false;
    const promise = sleepCancellable(1000).then(() => {
      resolved = true;
    });

    await vi.advanceTimersByTimeAsync(999);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await promise;
    expect(resolved).toBe(true);
  });

  it('resolves early when `abortSignal` fires mid-sleep', async () => {
    const controller = new AbortController();
    let resolved = false;
    const promise = sleepCancellable(60_000, controller.signal).then(() => {
      resolved = true;
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(resolved).toBe(false);
    controller.abort();
    await promise;
    expect(resolved).toBe(true);
  });

  it('resolves immediately when the signal is already aborted at call time', async () => {
    const controller = new AbortController();
    controller.abort();
    let resolved = false;
    const promise = sleepCancellable(60_000, controller.signal).then(() => {
      resolved = true;
    });
    await promise;
    expect(resolved).toBe(true);
  });

  it('removes its abort listener after the timer fires (no listener leak on the long-poll path)', async () => {
    const controller = new AbortController();
    const removeSpy = vi.spyOn(controller.signal, 'removeEventListener');
    const promise = sleepCancellable(100, controller.signal);
    await vi.advanceTimersByTimeAsync(100);
    await promise;
    expect(removeSpy).toHaveBeenCalledWith('abort', expect.any(Function));
  });
});
