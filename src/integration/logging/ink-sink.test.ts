/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { IsoTimestamp } from '@src/domain/values/iso-timestamp.ts';
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
    expect(seen[0]!.context).toStrictEqual({ sprintId: '20260429-120000-x' });
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

    expect(seen[0]!.context).toStrictEqual({
      app: 'ralphctl',
      sprintId: 'abc',
      taskId: 'def',
    });
  });

  it('publishes success() events with level: "success" to the bus', () => {
    const bus = new InMemoryLogEventBus();
    const seen: LogEvent[] = [];
    bus.subscribe((e) => seen.push(e));

    const sink = new InkSink(bus, { level: 'debug', now: () => FIXED_NOW });
    sink.success('task done');

    expect(seen).toHaveLength(1);
    expect(seen[0]!.level).toBe('success');
    expect(seen[0]!.message).toBe('task done');
  });

  it('treats success as info-tier — suppressed at warn level', () => {
    const bus = new InMemoryLogEventBus();
    const seen: LogEvent[] = [];
    bus.subscribe((e) => seen.push(e));

    const sink = new InkSink(bus, { level: 'warn', now: () => FIXED_NOW });
    sink.success('milestone');

    expect(seen).toHaveLength(0);
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

    expect(seen.map((e) => e.level)).toStrictEqual(['error']);
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

  describe('session-context auto-tagging', () => {
    it('attaches sessionId from the active runWithSession scope', async () => {
      const { runWithSession } = await import('@src/kernel/runtime/session-context.ts');
      const bus = new InMemoryLogEventBus();
      const seen: LogEvent[] = [];
      bus.subscribe((e) => seen.push(e));

      const sink = new InkSink(bus, { level: 'debug', now: () => FIXED_NOW });
      await runWithSession('sess-X', () => {
        sink.info('inside scope');
        return Promise.resolve();
      });
      sink.info('outside scope');

      expect(seen).toHaveLength(2);
      expect(seen[0]!.context['sessionId']).toBe('sess-X');
      expect(seen[1]!.context['sessionId']).toBeUndefined();
    });

    it('caller-provided context.sessionId wins over the active scope', async () => {
      const { runWithSession } = await import('@src/kernel/runtime/session-context.ts');
      const bus = new InMemoryLogEventBus();
      const seen: LogEvent[] = [];
      bus.subscribe((e) => seen.push(e));

      const sink = new InkSink(bus, { level: 'debug', now: () => FIXED_NOW });
      await runWithSession('sess-A', () => {
        sink.info('cross-tagged', { sessionId: 'sess-B' });
        return Promise.resolve();
      });

      expect(seen[0]!.context['sessionId']).toBe('sess-B');
    });

    it('keeps two concurrent scopes isolated when emissions interleave', async () => {
      const { runWithSession } = await import('@src/kernel/runtime/session-context.ts');
      const bus = new InMemoryLogEventBus();
      const seen: LogEvent[] = [];
      bus.subscribe((e) => seen.push(e));

      const sink = new InkSink(bus, { level: 'debug', now: () => FIXED_NOW });

      const a = runWithSession('A', async () => {
        for (let i = 0; i < 3; i++) {
          sink.info(`a-${String(i)}`);
          await Promise.resolve();
        }
      });
      const b = runWithSession('B', async () => {
        for (let i = 0; i < 3; i++) {
          sink.info(`b-${String(i)}`);
          await Promise.resolve();
        }
      });
      await Promise.all([a, b]);

      // Every event tagged with its emitting scope; no bleed.
      const aEvents = seen.filter((e) => typeof e.message === 'string' && e.message.startsWith('a-'));
      const bEvents = seen.filter((e) => typeof e.message === 'string' && e.message.startsWith('b-'));
      expect(aEvents).toHaveLength(3);
      expect(bEvents).toHaveLength(3);
      for (const e of aEvents) expect(e.context['sessionId']).toBe('A');
      for (const e of bEvents) expect(e.context['sessionId']).toBe('B');
    });
  });
});
