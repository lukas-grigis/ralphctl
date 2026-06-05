/**
 * Coverage for the launch.ts log-forwarder wiring in isolation. `createLogForwarder` is a
 * module-private helper in launch.ts (a full `launchTui` bootstrap mounts Ink + real storage, so
 * it is not a feasible unit), but its behaviour is the composition of three exported pieces:
 * gate-at-ingest (`passesLogLevel`) + CoalescedBuffer + BusSink. We reconstruct that exact wiring
 * and assert the two properties the fix depends on:
 *
 *   1. Admitted events flush as ONE batch into the bus, not one emit per push (the OOM fix).
 *   2. Delta semantics (`clearOnFlush:true`): consecutive flushes with new pushes between them
 *      never re-emit prior-flush events — the bus holds each admitted event exactly once.
 *   3. `onCritical`-style teardown: `discard()` drops the held window WITHOUT re-emitting it, then
 *      `clear()` empties the bus, so the post-critical bus only contains events pushed afterwards.
 *
 * Fake timers are fine — no React in this layer (mirrors heap-watchdog.test.ts).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCoalescedBuffer } from '@src/application/ui/tui/runtime/coalesced-buffer.ts';
import { createBusSink } from '@src/application/ui/tui/runtime/sinks-bus.ts';
import { createLogLevelGate, passesLogLevel } from '@src/business/observability/log-level-filter.ts';
import type { LogEvent } from '@src/business/observability/events.ts';
import { isoTimestamp } from '@tests/fixtures/domain.ts';

const NOW = isoTimestamp('2026-06-05T10:00:00.000Z');

const logEvent = (level: LogEvent['level'], message: string): LogEvent => ({
  type: 'log',
  level,
  message,
  at: NOW,
});

/**
 * Reconstruct the launch.ts forwarder: gate-at-ingest → coalescer → logBus. Mirrors the real
 * wiring's `clearOnFlush:true` (delta re-emit, no duplicates) and exposes a `critical()` that
 * models `onCritical`: `discard()` the held batch THEN `clear()` the bus.
 */
const wireForwarder = (floor: LogEvent['level']) => {
  const logBus = createBusSink<LogEvent>({ maxEntries: 2000 });
  const gate = createLogLevelGate(floor);
  const buffer = createCoalescedBuffer<LogEvent>({
    limit: 2000,
    flushMs: 100,
    clearOnFlush: true,
    onFlush: (window) => {
      for (const event of window) logBus.emit(event);
    },
  });
  const ingest = (event: LogEvent): void => {
    if (passesLogLevel(event.level, gate.get())) buffer.push(event);
  };
  const critical = (): void => {
    buffer.discard();
    logBus.clear();
  };
  return { logBus, gate, buffer, ingest, critical };
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('launch log-forwarder coalescing', () => {
  it('drops sub-floor events at ingest and coalesces admitted ones into one flush window', () => {
    const f = wireForwarder('info');
    let emits = 0;
    f.logBus.subscribe(() => (emits += 1));

    // 100 debug lines (below the info floor) → dropped at ingest, never buffered.
    for (let i = 0; i < 100; i++) f.ingest(logEvent('debug', `noise-${i}`));
    // 50 info lines → admitted, accumulate in one window.
    for (let i = 0; i < 50; i++) f.ingest(logEvent('info', `keep-${i}`));

    expect(emits).toBe(0); // nothing emitted before a flush tick
    vi.advanceTimersByTime(100); // one flush
    expect(emits).toBe(50); // all 50 admitted, in a single coalesced flush
    expect(f.logBus.entries.map((e) => e.message)).toContain('keep-49');
    f.buffer.stop();
  });

  it('two consecutive flushes with new pushes between them never duplicate (delta re-emit)', () => {
    const f = wireForwarder('debug');

    for (let i = 0; i < 5; i++) f.ingest(logEvent('debug', `a-${i}`));
    vi.advanceTimersByTime(100); // flush 1 → emits a-0..a-4, window cleared
    for (let i = 0; i < 3; i++) f.ingest(logEvent('debug', `b-${i}`));
    vi.advanceTimersByTime(100); // flush 2 → emits ONLY b-0..b-2, not a-* again

    const messages = f.logBus.entries.map((e) => e.message);
    expect(messages).toEqual(['a-0', 'a-1', 'a-2', 'a-3', 'a-4', 'b-0', 'b-1', 'b-2']);
    // No duplicates: every admitted event appears exactly once.
    expect(messages).toHaveLength(new Set(messages).size);
    f.buffer.stop();
  });

  it('after onCritical (discard + clear), a later push lands ONLY the new event — no repopulate', () => {
    const f = wireForwarder('debug');
    for (let i = 0; i < 10; i++) f.ingest(logEvent('debug', `held-${i}`));

    // onCritical: discard() drops the held batch WITHOUT emitting it, then clear() empties the bus.
    f.critical();
    expect(f.logBus.entries).toHaveLength(0);

    // A fresh push + one interval: the bus must contain only the post-critical event — the
    // pre-critical batch was dropped, not re-fed.
    f.ingest(logEvent('debug', 'after-critical'));
    vi.advanceTimersByTime(100);
    expect(f.logBus.entries.map((e) => e.message)).toEqual(['after-critical']);
    f.buffer.stop();
  });

  it('honours a live floor change (gate read per event at ingest)', () => {
    const f = wireForwarder('info');
    f.ingest(logEvent('debug', 'before')); // dropped at info floor
    f.gate.set('debug'); // operator lifts the floor at runtime
    f.ingest(logEvent('debug', 'after')); // now admitted

    vi.advanceTimersByTime(100);
    expect(f.logBus.entries.map((e) => e.message)).toEqual(['after']);
    f.buffer.stop();
  });
});
