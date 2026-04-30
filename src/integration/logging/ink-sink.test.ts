/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { IsoTimestamp } from '../../domain/values/iso-timestamp.ts';
import { InkSink } from './ink-sink.ts';
import { InMemoryLogEventBus, type LogEvent } from './log-event-bus.ts';

const ORIGINAL_LEVEL = process.env['RALPHCTL_LOG_LEVEL'];
const ORIGINAL_VITEST = process.env['VITEST'];
const FIXED_NOW = IsoTimestamp.trustString('2026-04-29T00:00:00.000Z');

describe('InkSink', () => {
  beforeEach(() => {
    delete process.env['VITEST'];
    delete process.env['RALPHCTL_LOG_LEVEL'];
  });
  afterEach(() => {
    if (ORIGINAL_VITEST !== undefined) process.env['VITEST'] = ORIGINAL_VITEST;
    if (ORIGINAL_LEVEL !== undefined) process.env['RALPHCTL_LOG_LEVEL'] = ORIGINAL_LEVEL;
  });

  it('publishes events to the supplied bus', () => {
    const bus = new InMemoryLogEventBus();
    const seen: LogEvent[] = [];
    bus.subscribe((e) => seen.push(e));

    const sink = new InkSink(bus, { level: 'debug', now: () => FIXED_NOW });
    sink.info('hello', { sprintId: '20260429-120000-x' });

    expect(seen).toHaveLength(1);
    expect(seen[0]!.level).toBe('info');
    expect(seen[0]!.message).toBe('hello');
    expect(seen[0]!.timestamp).toBe(FIXED_NOW);
    expect(seen[0]!.context).toEqual({ sprintId: '20260429-120000-x' });
  });

  it('merges constructor + child + per-call context', () => {
    const bus = new InMemoryLogEventBus();
    const seen: LogEvent[] = [];
    bus.subscribe((e) => seen.push(e));

    const root = new InkSink(bus, {
      level: 'debug',
      context: { app: 'ralphctl' },
      now: () => FIXED_NOW,
    });
    const child = root.child({ sprintId: 'abc' });
    child.warn('w', { taskId: 'def' });

    expect(seen[0]!.context).toEqual({
      app: 'ralphctl',
      sprintId: 'abc',
      taskId: 'def',
    });
  });

  it('honours level filtering — debug suppressed at info', () => {
    const bus = new InMemoryLogEventBus();
    const seen: LogEvent[] = [];
    bus.subscribe((e) => seen.push(e));

    const sink = new InkSink(bus, { level: 'info', now: () => FIXED_NOW });
    sink.debug('hidden');
    sink.info('shown');

    expect(seen).toHaveLength(1);
    expect(seen[0]!.message).toBe('shown');
  });

  it('respects RALPHCTL_LOG_LEVEL env var', () => {
    process.env['RALPHCTL_LOG_LEVEL'] = 'error';
    const bus = new InMemoryLogEventBus();
    const seen: LogEvent[] = [];
    bus.subscribe((e) => seen.push(e));

    const sink = new InkSink(bus, { now: () => FIXED_NOW });
    sink.warn('skip');
    sink.error('show');

    expect(seen).toHaveLength(1);
    expect(seen[0]!.level).toBe('error');
  });

  it('silences info/warn under VITEST=1 by default', () => {
    process.env['VITEST'] = '1';
    const bus = new InMemoryLogEventBus();
    const seen: LogEvent[] = [];
    bus.subscribe((e) => seen.push(e));

    const sink = new InkSink(bus, { now: () => FIXED_NOW });
    sink.info('skip');
    sink.warn('also');
    sink.error('shown');

    expect(seen.map((e) => e.level)).toEqual(['error']);
  });

  it('time() emits debug record carrying ms', () => {
    const bus = new InMemoryLogEventBus();
    const seen: LogEvent[] = [];
    bus.subscribe((e) => seen.push(e));

    const sink = new InkSink(bus, { level: 'debug', now: () => FIXED_NOW });
    const stop = sink.time('plan');
    stop();

    expect(seen).toHaveLength(1);
    expect(seen[0]!.message).toBe('plan');
    expect(typeof seen[0]!.context['ms']).toBe('number');
  });
});
