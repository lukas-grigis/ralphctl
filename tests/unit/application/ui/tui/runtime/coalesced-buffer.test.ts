/**
 * Pure unit coverage for the consumer-side coalescer. Fake timers are fine here — this layer has
 * no React (mirrors heap-watchdog.test.ts). The core guarantees: flush rate is O(elapsed/flushMs)
 * not O(pushes), the trailing window never exceeds `limit`, `flushNow` delivers the final batch,
 * `stop()` leaks no timer, and an idle buffer never flushes.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCoalescedBuffer } from '@src/application/ui/tui/runtime/coalesced-buffer.ts';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createCoalescedBuffer', () => {
  it('coalesces a flood into O(elapsed/flushMs) flushes, not one-per-push', () => {
    const windows: number[][] = [];
    const buf = createCoalescedBuffer<number>({
      limit: 1000,
      flushMs: 100,
      onFlush: (w) => windows.push([...w]),
    });

    // Push 10_000 values, advancing the clock by one flush interval every 1000 pushes.
    for (let i = 0; i < 10_000; i++) {
      buf.push(i);
      if (i % 1000 === 999) vi.advanceTimersByTime(100);
    }

    // 10 advances → at most ~10 flushes, NOT 10_000.
    expect(windows.length).toBeLessThanOrEqual(11);
    expect(windows.length).toBeGreaterThan(0);
    buf.stop();
  });

  it('never lets the trailing window exceed limit (cap on overflow between flushes)', () => {
    let maxLen = 0;
    const buf = createCoalescedBuffer<number>({
      limit: 50,
      flushMs: 100,
      onFlush: (w) => {
        maxLen = Math.max(maxLen, w.length);
      },
    });

    // 5000 pushes with NO timer advance between them — the overflow cap must still bound the
    // window so a flush (or the final flushNow) never hands out more than `limit`.
    for (let i = 0; i < 5000; i++) buf.push(i);
    buf.flushNow();

    expect(maxLen).toBe(50);
    buf.stop();
  });

  it('flushNow delivers the final batch synchronously with the trailing window', () => {
    const windows: number[][] = [];
    const buf = createCoalescedBuffer<number>({
      limit: 3,
      flushMs: 1000,
      onFlush: (w) => windows.push([...w]),
    });

    buf.push(1);
    buf.push(2);
    buf.push(3);
    buf.push(4);
    buf.flushNow();

    expect(windows).toEqual([[2, 3, 4]]);
    buf.stop();
  });

  it('seeds the window from initial (trimmed to limit) and includes it in the first flush', () => {
    const windows: number[][] = [];
    const buf = createCoalescedBuffer<number>({
      limit: 3,
      flushMs: 1000,
      initial: [10, 20, 30, 40],
      onFlush: (w) => windows.push([...w]),
    });

    buf.push(50);
    buf.flushNow();

    // initial trimmed to last 3 → [20,30,40], then push 50 overflows → [30,40,50].
    expect(windows).toEqual([[30, 40, 50]]);
    buf.stop();
  });

  it('does not flush when idle (no pushes between ticks)', () => {
    const onFlush = vi.fn();
    const buf = createCoalescedBuffer<number>({ limit: 10, flushMs: 100, onFlush });

    vi.advanceTimersByTime(1000); // 10 ticks, zero pushes
    buf.flushNow(); // explicit flush with nothing dirty

    expect(onFlush).not.toHaveBeenCalled();
    buf.stop();
  });

  it('leaks no timer after stop()', () => {
    const buf = createCoalescedBuffer<number>({ limit: 10, flushMs: 100, onFlush: () => undefined });
    buf.push(1);
    buf.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stop() is idempotent', () => {
    const buf = createCoalescedBuffer<number>({ limit: 10, onFlush: () => undefined });
    buf.stop();
    expect(() => buf.stop()).not.toThrow();
  });

  it('clearOnFlush:true empties the window after each flush — a flush carries only new pushes', () => {
    const windows: number[][] = [];
    const buf = createCoalescedBuffer<number>({
      limit: 1000,
      flushMs: 100,
      clearOnFlush: true,
      onFlush: (w) => windows.push([...w]),
    });

    buf.push(1);
    buf.push(2);
    vi.advanceTimersByTime(100); // first flush → [1, 2], window then cleared
    buf.push(3);
    vi.advanceTimersByTime(100); // second flush → only [3], not [1, 2, 3]

    expect(windows).toEqual([[1, 2], [3]]);
    buf.stop();
  });

  it('discard() empties the window without calling onFlush and resets dirty', () => {
    const onFlush = vi.fn();
    const buf = createCoalescedBuffer<number>({ limit: 10, flushMs: 100, onFlush });

    buf.push(1);
    buf.push(2);
    buf.discard(); // drop the held batch — no onFlush
    expect(onFlush).not.toHaveBeenCalled();

    // dirty was reset: a flush tick with nothing new must not fire onFlush either.
    vi.advanceTimersByTime(100);
    buf.flushNow();
    expect(onFlush).not.toHaveBeenCalled();

    // The window is genuinely empty: a fresh push then flush delivers ONLY the new value.
    buf.push(3);
    buf.flushNow();
    expect(onFlush).toHaveBeenCalledTimes(1);
    expect(onFlush).toHaveBeenCalledWith([3]);
    buf.stop();
  });

  it('floors flushMs at 16ms when a shorter interval is requested', () => {
    const onFlush = vi.fn();
    const buf = createCoalescedBuffer<number>({ limit: 10, flushMs: 1, onFlush });
    buf.push(1);

    vi.advanceTimersByTime(15); // below the 16ms floor — must not have fired yet
    expect(onFlush).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1); // now at 16ms
    expect(onFlush).toHaveBeenCalledTimes(1);
    buf.stop();
  });
});
