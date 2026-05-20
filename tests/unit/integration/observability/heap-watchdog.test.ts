import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MemoryPressureEvent } from '@src/business/observability/events.ts';
import { startHeapWatchdog, type HeapReading } from '@src/integration/observability/heap-watchdog.ts';
import { createInMemoryEventBus } from '@src/integration/observability/in-memory-event-bus.ts';
import { isoTimestamp } from '@tests/fixtures/domain.ts';

const HEAP_LIMIT = 4_000_000_000; // 4 GB
const NOW = isoTimestamp('2026-05-20T10:00:00.000Z');

const readingForRatio = (ratio: number): HeapReading => ({
  heapUsed: Math.round(HEAP_LIMIT * ratio),
  heapLimit: HEAP_LIMIT,
});

/**
 * Test harness: build a watchdog with an injected ratio queue. Each call to
 * advanceOnce() steps fake timers by intervalMs so setInterval fires exactly once.
 */
const createHarness = (opts: { readonly onCritical?: () => void } = {}) => {
  const ratios: number[] = [];
  const bus = createInMemoryEventBus();
  const events: MemoryPressureEvent[] = [];
  bus.subscribe((event) => {
    if (event.type === 'memory-pressure') events.push(event);
  });

  const readHeap = (): HeapReading => {
    const next = ratios.shift();
    if (next === undefined) throw new Error('test: no more ratios queued');
    return readingForRatio(next);
  };

  const watchdog = startHeapWatchdog({
    eventBus: bus,
    clock: () => NOW,
    intervalMs: 1000,
    warningRatio: 0.8,
    criticalRatio: 0.95,
    readHeap,
    ...(opts.onCritical !== undefined ? { onCritical: opts.onCritical } : {}),
  });

  return {
    watchdog,
    events,
    queueRatios: (...rs: number[]): void => {
      ratios.push(...rs);
    },
    advanceOnce: (): void => {
      vi.advanceTimersByTime(1000);
    },
  };
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('startHeapWatchdog', () => {
  it('emits no event while the ratio stays below the warning threshold', () => {
    const h = createHarness();
    h.queueRatios(0.1, 0.5, 0.79);
    h.advanceOnce();
    h.advanceOnce();
    h.advanceOnce();

    expect(h.events).toEqual([]);
    h.watchdog.stop();
  });

  it("emits exactly one 'warning' event on first crossing of the warning ratio", () => {
    const h = createHarness();
    h.queueRatios(0.5, 0.85, 0.86, 0.9);
    h.advanceOnce(); // 0.5 → ok, no event
    h.advanceOnce(); // 0.85 → warning, event
    h.advanceOnce(); // 0.86 → still warning, no event
    h.advanceOnce(); // 0.9 → still warning, no event

    expect(h.events).toHaveLength(1);
    expect(h.events[0]?.severity).toBe('warning');
    expect(h.events[0]?.ratio).toBeCloseTo(0.85, 5);
    h.watchdog.stop();
  });

  it("emits exactly one 'critical' event on first crossing of the critical ratio", () => {
    const h = createHarness();
    h.queueRatios(0.5, 0.96, 0.97);
    h.advanceOnce(); // 0.5 → ok
    h.advanceOnce(); // 0.96 → critical, event (skipping warning band)
    h.advanceOnce(); // 0.97 → still critical, no event

    expect(h.events).toHaveLength(1);
    expect(h.events[0]?.severity).toBe('critical');
    h.watchdog.stop();
  });

  it('fires onCritical exactly once when severity enters critical', () => {
    const onCritical = vi.fn();
    const h = createHarness({ onCritical });
    h.queueRatios(0.5, 0.85, 0.96, 0.97, 0.98);
    h.advanceOnce(); // ok
    h.advanceOnce(); // warning
    h.advanceOnce(); // critical → fires onCritical
    h.advanceOnce(); // critical (no transition)
    h.advanceOnce(); // critical (no transition)

    expect(onCritical).toHaveBeenCalledTimes(1);
    h.watchdog.stop();
  });

  it("emits one 'recovered' event when the ratio drops back below the warning floor", () => {
    const h = createHarness();
    h.queueRatios(0.5, 0.85, 0.5, 0.4);
    h.advanceOnce(); // ok
    h.advanceOnce(); // warning
    h.advanceOnce(); // recovered
    h.advanceOnce(); // ok, no event

    expect(h.events.map((e) => e.severity)).toEqual(['warning', 'recovered']);
    h.watchdog.stop();
  });

  it('re-arms across ok → warning → critical → warning → critical (no duplicate band events)', () => {
    const onCritical = vi.fn();
    const h = createHarness({ onCritical });
    h.queueRatios(0.5, 0.85, 0.96, 0.85, 0.96);
    h.advanceOnce(); // ok
    h.advanceOnce(); // warning
    h.advanceOnce(); // critical (onCritical 1)
    h.advanceOnce(); // warning (transition down)
    h.advanceOnce(); // critical (onCritical 2)

    expect(h.events.map((e) => e.severity)).toEqual(['warning', 'critical', 'warning', 'critical']);
    expect(onCritical).toHaveBeenCalledTimes(2);
    h.watchdog.stop();
  });

  it('stop() halts further sampling and emissions', () => {
    const h = createHarness();
    h.queueRatios(0.5, 0.85);
    h.advanceOnce(); // ok
    h.watchdog.stop();
    h.queueRatios(0.96, 0.97); // would-be critical, but watchdog is stopped
    h.advanceOnce();
    h.advanceOnce();

    expect(h.events).toEqual([]);
  });

  it('stop() is idempotent', () => {
    const h = createHarness();
    h.queueRatios(0.5);
    h.advanceOnce();
    h.watchdog.stop();
    expect(() => h.watchdog.stop()).not.toThrow();
  });

  it('floors the polling interval at 1000ms even when a shorter interval is requested', () => {
    const bus = createInMemoryEventBus();
    const events: MemoryPressureEvent[] = [];
    bus.subscribe((event) => {
      if (event.type === 'memory-pressure') events.push(event);
    });
    const ratios = [0.5, 0.85];
    const watchdog = startHeapWatchdog({
      eventBus: bus,
      clock: () => NOW,
      intervalMs: 1, // requested 1ms — floor should bump this to 1000
      warningRatio: 0.8,
      criticalRatio: 0.95,
      readHeap: () => readingForRatio(ratios.shift() ?? 0),
    });

    vi.advanceTimersByTime(999);
    expect(events).toEqual([]); // not yet fired

    vi.advanceTimersByTime(1); // now at 1000ms — first tick
    vi.advanceTimersByTime(1000); // second tick → warning
    expect(events.map((e) => e.severity)).toEqual(['warning']);
    watchdog.stop();
  });

  it('populates heapUsed, heapLimit, and at on each emitted event', () => {
    const h = createHarness();
    h.queueRatios(0.5, 0.85);
    h.advanceOnce();
    h.advanceOnce();

    expect(h.events[0]).toMatchObject({
      type: 'memory-pressure',
      severity: 'warning',
      heapUsed: Math.round(HEAP_LIMIT * 0.85),
      heapLimit: HEAP_LIMIT,
      at: NOW,
    });
    h.watchdog.stop();
  });

  it('swallows a throwing onCritical and continues polling', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const onCritical = vi.fn(() => {
      throw new Error('boom');
    });
    const h = createHarness({ onCritical });
    h.queueRatios(0.5, 0.96, 0.5);
    h.advanceOnce(); // ok
    h.advanceOnce(); // critical → onCritical throws but watchdog continues
    h.advanceOnce(); // recovered

    expect(h.events.map((e) => e.severity)).toEqual(['critical', 'recovered']);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    h.watchdog.stop();
  });
});
