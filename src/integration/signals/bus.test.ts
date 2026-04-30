import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SignalBusEvent } from '../../business/ports/signal-bus-port.ts';
import { TaskId } from '../../domain/values/task-id.ts';
import { InMemorySignalBus, NoopSignalBus } from './bus.ts';

const TASK_A = TaskId.trustString('aaaaaaaa');
const TASK_B = TaskId.trustString('bbbbbbbb');

const startedA: SignalBusEvent = { type: 'task-started', taskId: TASK_A };
const startedB: SignalBusEvent = { type: 'task-started', taskId: TASK_B };
const finishedA: SignalBusEvent = {
  type: 'task-finished',
  taskId: TASK_A,
  status: 'completed',
};

describe('InMemorySignalBus', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('delivers events in emission order to a single subscriber', () => {
    const bus = new InMemorySignalBus({ intervalMs: 16 });
    const received: SignalBusEvent[] = [];
    bus.subscribe((e) => received.push(e));

    bus.emit(startedA);
    bus.emit(startedB);
    bus.emit(finishedA);
    expect(received).toHaveLength(0);

    vi.advanceTimersByTime(16);
    expect(received).toEqual([startedA, startedB, finishedA]);
    bus.dispose();
  });

  it('fans out a single event to multiple subscribers', () => {
    const bus = new InMemorySignalBus({ intervalMs: 16 });
    const a: SignalBusEvent[] = [];
    const b: SignalBusEvent[] = [];
    bus.subscribe((e) => a.push(e));
    bus.subscribe((e) => b.push(e));

    bus.emit(startedA);
    vi.advanceTimersByTime(16);

    expect(a).toEqual([startedA]);
    expect(b).toEqual([startedA]);
    bus.dispose();
  });

  it('coalesces emissions within the micro-batch window', () => {
    const bus = new InMemorySignalBus({ intervalMs: 16 });
    let flushes = 0;
    const events: SignalBusEvent[] = [];
    bus.subscribe((e) => {
      flushes++;
      events.push(e);
    });

    bus.emit(startedA);
    bus.emit(startedB);
    bus.emit(finishedA);
    expect(flushes).toBe(0); // nothing delivered yet

    vi.advanceTimersByTime(16);
    expect(events).toEqual([startedA, startedB, finishedA]);
    bus.dispose();
  });

  it('starts a fresh window after a flush', () => {
    const bus = new InMemorySignalBus({ intervalMs: 16 });
    const events: SignalBusEvent[] = [];
    bus.subscribe((e) => events.push(e));

    bus.emit(startedA);
    vi.advanceTimersByTime(16);
    expect(events).toEqual([startedA]);

    bus.emit(startedB);
    vi.advanceTimersByTime(8);
    expect(events).toEqual([startedA]);
    vi.advanceTimersByTime(8);
    expect(events).toEqual([startedA, startedB]);
    bus.dispose();
  });

  it('isolates a throwing listener from other listeners', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const bus = new InMemorySignalBus({ intervalMs: 16 });
    const ok: SignalBusEvent[] = [];
    bus.subscribe(() => {
      throw new Error('boom');
    });
    bus.subscribe((e) => ok.push(e));

    bus.emit(startedA);
    vi.advanceTimersByTime(16);

    expect(ok).toEqual([startedA]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    bus.dispose();
  });

  it('unsubscribe stops delivery to that listener', () => {
    const bus = new InMemorySignalBus({ intervalMs: 16 });
    const events: SignalBusEvent[] = [];
    const off = bus.subscribe((e) => events.push(e));

    bus.emit(startedA);
    vi.advanceTimersByTime(16);
    expect(events).toEqual([startedA]);

    off();
    bus.emit(startedB);
    vi.advanceTimersByTime(16);
    expect(events).toEqual([startedA]); // unchanged
    bus.dispose();
  });

  it('dispose() flushes pending events synchronously', () => {
    const bus = new InMemorySignalBus({ intervalMs: 16 });
    const events: SignalBusEvent[] = [];
    bus.subscribe((e) => events.push(e));

    bus.emit(startedA);
    bus.emit(startedB);
    bus.dispose();

    expect(events).toEqual([startedA, startedB]);
  });

  it('dispose() drops subsequent emissions and subscriptions', () => {
    const bus = new InMemorySignalBus({ intervalMs: 16 });
    bus.dispose();

    const events: SignalBusEvent[] = [];
    const off = bus.subscribe((e) => events.push(e));
    bus.emit(startedA);
    vi.advanceTimersByTime(16);

    expect(events).toEqual([]);
    // Returned unsubscribe is a no-op (no entry was added).
    expect(() => {
      off();
    }).not.toThrow();
  });
});

describe('NoopSignalBus', () => {
  it('emit/subscribe/dispose are no-ops and never throw', () => {
    const bus = new NoopSignalBus();
    expect(() => {
      bus.emit(startedA);
    }).not.toThrow();
    const off = bus.subscribe(() => undefined);
    expect(() => {
      off();
    }).not.toThrow();
    expect(() => {
      bus.dispose();
    }).not.toThrow();
  });
});
