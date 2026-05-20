/**
 * file-log-sink — back-pressure + write-fail observability contract.
 *
 * Three things to pin:
 *  - Normal drain: queue never balloons past the cap, no degradation event published.
 *  - Cap hit: stall the disk write, push >MAX_QUEUE events, assert exactly one
 *    `chain-log-degraded` (`reason: 'queue-full'`) is emitted and that further drops do
 *    not re-emit (one-shot latch).
 *  - Write fail: reject `fs.appendFile`, assert exactly one `chain-log-degraded`
 *    (`reason: 'write-failed'`) is emitted and a subsequent failing append is silent.
 *
 * Why we spy on the namespace `fs` import: the production module also imports
 * `{ promises as fs } from 'node:fs'`. Both imports resolve to the same singleton, so
 * `vi.spyOn(fs, 'appendFile')` here also intercepts calls inside the sink — no module
 * factory mock required, and the production import path stays direct.
 */

import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp, readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { AppEvent, ChainLogDegradedEvent, LogEvent } from '@src/business/observability/events.ts';
import { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import { createInMemoryEventBus } from '@src/integration/observability/in-memory-event-bus.ts';
import { startFileLogSink } from '@src/integration/observability/sinks/file-log-sink.ts';

const makeLog = (i: number): LogEvent => ({
  type: 'log',
  level: 'info',
  message: `event-${i}`,
  at: IsoTimestamp.now(),
});

const makeFilePath = async (): Promise<AbsolutePath> => {
  const dir = await mkdtemp(join(tmpdir(), 'file-log-sink-'));
  const parsed = AbsolutePath.parse(join(dir, 'chain.log'));
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.value;
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('startFileLogSink', () => {
  it('normal drain — writes every event and never publishes a degradation event', async () => {
    const file = await makeFilePath();
    const bus = createInMemoryEventBus();
    const degradations: ChainLogDegradedEvent[] = [];
    bus.subscribe((e) => {
      if (e.type === 'chain-log-degraded') degradations.push(e);
    });

    const sink = startFileLogSink({ file, bus });
    for (let i = 0; i < 50; i++) bus.publish(makeLog(i));
    await sink.flush();
    sink.stop();

    expect(degradations).toEqual([]);
    const written = await readFile(String(file), 'utf8');
    const lines = written.trim().split('\n');
    expect(lines).toHaveLength(50);
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({ type: 'log', message: 'event-0' });
    expect(JSON.parse(lines[49] ?? '{}')).toMatchObject({ type: 'log', message: 'event-49' });
  });

  it('queue cap — drops newest and emits exactly one queue-full degradation', async () => {
    const file = await makeFilePath();
    const bus = createInMemoryEventBus();
    const degradations: ChainLogDegradedEvent[] = [];
    bus.subscribe((e) => {
      if (e.type === 'chain-log-degraded') degradations.push(e);
    });

    // Block the disk path so the drain loop parks the head of the queue forever — every
    // subsequent push lands behind it and the queue fills up to MAX_QUEUE.
    let releaseAppend: () => void = () => undefined;
    const appendStall = new Promise<void>((resolve) => {
      releaseAppend = resolve;
    });
    const appendSpy = vi.spyOn(fs, 'appendFile').mockImplementation(async () => {
      await appendStall;
    });

    const sink = startFileLogSink({ file, bus });
    // 10_000 cap + 5 extra. The drain loop pulls one off the queue immediately and parks on
    // the first appendFile, so steady state is queue.length === 9_999 after MAX_QUEUE
    // publishes. The next 5 publishes push the queue to the cap and then trip the drop path.
    const TOTAL = 10_010;
    for (let i = 0; i < TOTAL; i++) bus.publish(makeLog(i));

    // At least one drop must have fired — once degraded latches we do not re-emit.
    expect(degradations).toHaveLength(1);
    expect(degradations[0]?.reason).toBe('queue-full');

    // Subsequent overflows must NOT re-emit (the one-shot latch).
    for (let i = 0; i < 100; i++) bus.publish(makeLog(TOTAL + i));
    expect(degradations).toHaveLength(1);

    // Release the stalled write so the sink can shut down cleanly.
    releaseAppend();
    await sink.flush();
    sink.stop();

    expect(appendSpy).toHaveBeenCalled();
  });

  it('write fail — emits exactly one write-failed degradation and silences subsequent failures', async () => {
    const file = await makeFilePath();
    const bus = createInMemoryEventBus();
    const degradations: ChainLogDegradedEvent[] = [];
    bus.subscribe((e) => {
      if (e.type === 'chain-log-degraded') degradations.push(e);
    });

    const appendSpy = vi.spyOn(fs, 'appendFile').mockRejectedValue(new Error('disk full'));

    const sink = startFileLogSink({ file, bus });
    bus.publish(makeLog(0));
    await sink.flush();

    expect(degradations).toHaveLength(1);
    expect(degradations[0]?.reason).toBe('write-failed');
    expect(degradations[0]?.meta).toMatchObject({ error: 'disk full' });

    // A second failing append must not re-emit.
    bus.publish(makeLog(1));
    await sink.flush();
    expect(degradations).toHaveLength(1);

    sink.stop();
    expect(appendSpy).toHaveBeenCalled();
  });

  it('re-entrancy guard — does not enqueue its own degradation marker', async () => {
    const file = await makeFilePath();
    const bus = createInMemoryEventBus();
    vi.spyOn(fs, 'appendFile').mockRejectedValue(new Error('boom'));

    const written: AppEvent[] = [];
    bus.subscribe((e) => written.push(e));

    const sink = startFileLogSink({ file, bus });
    bus.publish(makeLog(0));
    await sink.flush();

    // The degradation marker was published once but the sink itself does not re-enqueue it,
    // so the second failing append never happens — degradations stay at one regardless.
    const degradations = written.filter((e) => e.type === 'chain-log-degraded');
    expect(degradations).toHaveLength(1);

    sink.stop();
  });
});
