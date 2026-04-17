import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { InMemorySignalBus, NoopSignalBus } from './bus.ts';
import type { HarnessEvent } from '@src/business/ports/signal-bus.ts';

function progressEvent(summary: string): HarnessEvent {
  return {
    type: 'signal',
    signal: { type: 'progress', summary, timestamp: new Date() },
    ctx: { sprintId: 's1' },
  };
}

describe('InMemorySignalBus', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('delivers events in emission order within a batch', () => {
    const bus = new InMemorySignalBus({ flushIntervalMs: 10 });
    const received: HarnessEvent[] = [];
    bus.subscribe((batch) => received.push(...batch));

    bus.emit(progressEvent('a'));
    bus.emit(progressEvent('b'));
    bus.emit(progressEvent('c'));

    vi.advanceTimersByTime(10);

    expect(received).toHaveLength(3);
    expect((received[0] as { signal: { summary: string } }).signal.summary).toBe('a');
    expect((received[2] as { signal: { summary: string } }).signal.summary).toBe('c');
  });

  it('coalesces multiple emits within the flush window into one listener call', () => {
    const bus = new InMemorySignalBus({ flushIntervalMs: 16 });
    const listener = vi.fn();
    bus.subscribe(listener);

    bus.emit(progressEvent('x'));
    bus.emit(progressEvent('y'));
    bus.emit(progressEvent('z'));

    vi.advanceTimersByTime(16);

    expect(listener).toHaveBeenCalledTimes(1);
    expect((listener.mock.calls[0] as [readonly HarnessEvent[]])[0]).toHaveLength(3);
  });

  it('starts a new batch after a flush', () => {
    const bus = new InMemorySignalBus({ flushIntervalMs: 10 });
    const listener = vi.fn();
    bus.subscribe(listener);

    bus.emit(progressEvent('a'));
    vi.advanceTimersByTime(10);
    bus.emit(progressEvent('b'));
    vi.advanceTimersByTime(10);

    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('unsubscribes cleanly', () => {
    const bus = new InMemorySignalBus({ flushIntervalMs: 5 });
    const listener = vi.fn();
    const unsub = bus.subscribe(listener);
    unsub();
    bus.emit(progressEvent('orphan'));
    vi.advanceTimersByTime(5);
    expect(listener).not.toHaveBeenCalled();
  });

  it('isolates listeners: one listener throwing does not block others', () => {
    const bus = new InMemorySignalBus({ flushIntervalMs: 5 });
    const good = vi.fn();
    bus.subscribe(() => {
      throw new Error('boom');
    });
    bus.subscribe(good);
    bus.emit(progressEvent('a'));
    vi.advanceTimersByTime(5);
    expect(good).toHaveBeenCalledTimes(1);
  });

  it('flush() drains immediately', () => {
    const bus = new InMemorySignalBus({ flushIntervalMs: 60_000 });
    const listener = vi.fn();
    bus.subscribe(listener);
    bus.emit(progressEvent('now'));
    bus.flush();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('dispose() drops listeners and stops delivery', () => {
    const bus = new InMemorySignalBus({ flushIntervalMs: 5 });
    const listener = vi.fn();
    bus.subscribe(listener);
    bus.dispose();
    bus.emit(progressEvent('a'));
    vi.advanceTimersByTime(5);
    expect(listener).not.toHaveBeenCalled();
  });

  it('emits rate-limit and task lifecycle event types', () => {
    const bus = new InMemorySignalBus({ flushIntervalMs: 5 });
    const received: HarnessEvent[] = [];
    bus.subscribe((batch) => received.push(...batch));

    const now = new Date();
    bus.emit({ type: 'rate-limit-paused', delayMs: 30_000, timestamp: now });
    bus.emit({ type: 'rate-limit-resumed', timestamp: now });
    bus.emit({ type: 'task-started', sprintId: 's1', taskId: 't1', taskName: 'x', timestamp: now });
    bus.emit({ type: 'task-finished', sprintId: 's1', taskId: 't1', status: 'done', timestamp: now });

    vi.advanceTimersByTime(5);

    expect(received).toHaveLength(4);
    expect(received.map((e) => e.type)).toEqual([
      'rate-limit-paused',
      'rate-limit-resumed',
      'task-started',
      'task-finished',
    ]);
  });
});

describe('NoopSignalBus', () => {
  it('accepts emit without error and subscribe is a no-op', () => {
    const bus = new NoopSignalBus();
    const listener = vi.fn();
    const unsub = bus.subscribe(listener);
    bus.emit({ type: 'rate-limit-resumed', timestamp: new Date() });
    unsub();
    bus.dispose();
    expect(listener).not.toHaveBeenCalled();
  });
});
