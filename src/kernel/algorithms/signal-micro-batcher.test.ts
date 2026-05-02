import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SignalMicroBatcher } from './signal-micro-batcher.ts';

describe('SignalMicroBatcher', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('a single push schedules one flush carrying that one item', () => {
    const batches: number[][] = [];
    const b = new SignalMicroBatcher<number>({
      intervalMs: 16,
      flush: (batch) => batches.push([...batch]),
    });

    b.push(1);
    expect(batches).toStrictEqual([]);
    vi.advanceTimersByTime(16);
    expect(batches).toStrictEqual([[1]]);
  });

  it('multiple pushes within the window coalesce into one flush', () => {
    const batches: number[][] = [];
    const b = new SignalMicroBatcher<number>({
      intervalMs: 16,
      flush: (batch) => batches.push([...batch]),
    });

    b.push(1);
    b.push(2);
    b.push(3);
    vi.advanceTimersByTime(16);
    expect(batches).toStrictEqual([[1, 2, 3]]);
  });

  it('subsequent pushes after a flush start a new window', () => {
    const batches: number[][] = [];
    const b = new SignalMicroBatcher<number>({
      intervalMs: 16,
      flush: (batch) => batches.push([...batch]),
    });

    b.push(1);
    vi.advanceTimersByTime(16);
    b.push(2);
    b.push(3);
    vi.advanceTimersByTime(16);
    expect(batches).toStrictEqual([[1], [2, 3]]);
  });

  it('flushNow() drains immediately and resets the timer', () => {
    const batches: number[][] = [];
    const b = new SignalMicroBatcher<number>({
      intervalMs: 16,
      flush: (batch) => batches.push([...batch]),
    });

    b.push(1);
    b.push(2);
    b.flushNow();
    expect(batches).toStrictEqual([[1, 2]]);

    // After flushNow, the next push must schedule a fresh window — not fire
    // at the would-have-been original deadline.
    b.push(3);
    vi.advanceTimersByTime(8);
    expect(batches).toStrictEqual([[1, 2]]);
    vi.advanceTimersByTime(8);
    expect(batches).toStrictEqual([[1, 2], [3]]);
  });

  it('flushNow() with an empty buffer is a no-op (no empty flush)', () => {
    const flush = vi.fn();
    const b = new SignalMicroBatcher<number>({ intervalMs: 16, flush });
    b.flushNow();
    expect(flush).not.toHaveBeenCalled();
  });

  it('dispose() flushes remaining items synchronously', () => {
    const batches: number[][] = [];
    const b = new SignalMicroBatcher<number>({
      intervalMs: 16,
      flush: (batch) => batches.push([...batch]),
    });

    b.push(1);
    b.push(2);
    b.dispose();
    expect(batches).toStrictEqual([[1, 2]]);
  });

  it('post-dispose push() is dropped (no flush)', () => {
    const flush = vi.fn();
    const b = new SignalMicroBatcher<number>({ intervalMs: 16, flush });
    b.dispose();
    b.push(1);
    b.push(2);
    vi.advanceTimersByTime(100);
    expect(flush).not.toHaveBeenCalled();
  });

  it('dispose() is idempotent', () => {
    const batches: number[][] = [];
    const b = new SignalMicroBatcher<number>({
      intervalMs: 16,
      flush: (batch) => batches.push([...batch]),
    });
    b.push(1);
    b.dispose();
    b.dispose();
    expect(batches).toStrictEqual([[1]]);
  });

  it('an empty batch is never flushed even when the timer fires', () => {
    const flush = vi.fn();
    const b = new SignalMicroBatcher<number>({ intervalMs: 16, flush });

    // No pushes — advancing time must not produce a flush.
    vi.advanceTimersByTime(1000);
    expect(flush).not.toHaveBeenCalled();

    // Push then flushNow drains; advancing time again must not produce a
    // second empty flush.
    b.push(1);
    b.flushNow();
    expect(flush).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    expect(flush).toHaveBeenCalledTimes(1);
  });
});
