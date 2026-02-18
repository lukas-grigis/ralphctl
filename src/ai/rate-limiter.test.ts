import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RateLimitCoordinator } from './rate-limiter.ts';

describe('RateLimitCoordinator', () => {
  let coordinator: RateLimitCoordinator;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    coordinator.dispose();
    vi.useRealTimers();
  });

  it('starts unpaused', () => {
    coordinator = new RateLimitCoordinator();
    expect(coordinator.isPaused).toBe(false);
    expect(coordinator.remainingMs).toBe(0);
  });

  it('pauses for the given duration', () => {
    coordinator = new RateLimitCoordinator();
    coordinator.pause(5000);
    expect(coordinator.isPaused).toBe(true);
    expect(coordinator.remainingMs).toBeGreaterThan(0);
    expect(coordinator.remainingMs).toBeLessThanOrEqual(5000);
  });

  it('resumes after the pause duration expires', () => {
    coordinator = new RateLimitCoordinator();
    coordinator.pause(5000);
    expect(coordinator.isPaused).toBe(true);

    vi.advanceTimersByTime(5000);
    expect(coordinator.isPaused).toBe(false);
    expect(coordinator.remainingMs).toBe(0);
  });

  it('extends pause when a longer duration is requested', () => {
    coordinator = new RateLimitCoordinator();
    coordinator.pause(3000);

    vi.advanceTimersByTime(1000);
    // Still paused, ~2s remaining
    expect(coordinator.isPaused).toBe(true);

    // Extend to 10s from now
    coordinator.pause(10000);
    expect(coordinator.isPaused).toBe(true);

    // Original 3s would have expired, but we extended
    vi.advanceTimersByTime(3000);
    expect(coordinator.isPaused).toBe(true);

    // Full 10s from the second pause
    vi.advanceTimersByTime(7000);
    expect(coordinator.isPaused).toBe(false);
  });

  it('does not shorten an existing pause', () => {
    coordinator = new RateLimitCoordinator();
    coordinator.pause(10000);

    // Try to set a shorter pause
    coordinator.pause(2000);
    expect(coordinator.isPaused).toBe(true);

    vi.advanceTimersByTime(3000);
    // Still paused because original 10s pause is in effect
    expect(coordinator.isPaused).toBe(true);
  });

  it('waitIfPaused resolves immediately when not paused', async () => {
    coordinator = new RateLimitCoordinator();
    await coordinator.waitIfPaused();
    // Should resolve without blocking
  });

  it('waitIfPaused resolves when pause expires', async () => {
    coordinator = new RateLimitCoordinator();
    coordinator.pause(5000);

    let resolved = false;
    const promise = coordinator.waitIfPaused().then(() => {
      resolved = true;
    });

    expect(resolved).toBe(false);

    vi.advanceTimersByTime(5000);
    await promise;
    expect(resolved).toBe(true);
  });

  it('wakes multiple waiters on resume', async () => {
    coordinator = new RateLimitCoordinator();
    coordinator.pause(5000);

    let waiter1Resolved = false;
    let waiter2Resolved = false;

    const p1 = coordinator.waitIfPaused().then(() => {
      waiter1Resolved = true;
    });
    const p2 = coordinator.waitIfPaused().then(() => {
      waiter2Resolved = true;
    });

    vi.advanceTimersByTime(5000);
    await Promise.all([p1, p2]);

    expect(waiter1Resolved).toBe(true);
    expect(waiter2Resolved).toBe(true);
  });

  it('calls onPause callback', () => {
    const onPause = vi.fn();
    coordinator = new RateLimitCoordinator({ onPause });
    coordinator.pause(5000);
    expect(onPause).toHaveBeenCalledWith(5000);
  });

  it('calls onResume callback', () => {
    const onResume = vi.fn();
    coordinator = new RateLimitCoordinator({ onResume });
    coordinator.pause(5000);
    vi.advanceTimersByTime(5000);
    expect(onResume).toHaveBeenCalledOnce();
  });

  it('dispose clears timer and wakes waiters', async () => {
    coordinator = new RateLimitCoordinator();
    coordinator.pause(60000);

    let resolved = false;
    const promise = coordinator.waitIfPaused().then(() => {
      resolved = true;
    });

    coordinator.dispose();
    await promise;
    expect(resolved).toBe(true);
    expect(coordinator.isPaused).toBe(false);
  });
});
