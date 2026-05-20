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
import type {
  AppEvent,
  ChainAbortedEvent,
  ChainCompletedEvent,
  ChainFailedEvent,
  ChainLogDegradedEvent,
  ChainStartedEvent,
  ChainStepCompletedEvent,
  ChainStepFailedEvent,
  LogEvent,
} from '@src/business/observability/events.ts';
import { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import { createInMemoryEventBus } from '@src/integration/observability/in-memory-event-bus.ts';
import { startFileLogSink } from '@src/integration/observability/sinks/file-log-sink.ts';
import { ConflictError } from '@src/domain/value/error/conflict-error.ts';

const makeLog = (i: number): LogEvent => ({
  type: 'log',
  level: 'info',
  message: `event-${i}`,
  at: IsoTimestamp.now(),
});

const iso = (s: string): IsoTimestamp => {
  const parsed = IsoTimestamp.parse(s);
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.value;
};

const started = (chainId: string, flowId: string, at: string): ChainStartedEvent => ({
  type: 'chain-started',
  chainId,
  flowId,
  at: iso(at),
});

const stepCompleted = (chainId: string, elementName: string, at: string): ChainStepCompletedEvent => ({
  type: 'chain-step-completed',
  chainId,
  elementName,
  durationMs: 1,
  at: iso(at),
});

const stepFailed = (chainId: string, elementName: string, at: string): ChainStepFailedEvent => ({
  type: 'chain-step-failed',
  chainId,
  elementName,
  error: new ConflictError({ entity: 'sprint', field: 'projectId', value: 'p' }),
  durationMs: 1,
  at: iso(at),
});

const chainCompleted = (chainId: string, at: string): ChainCompletedEvent => ({
  type: 'chain-completed',
  chainId,
  at: iso(at),
});

const chainFailed = (chainId: string, at: string): ChainFailedEvent => ({
  type: 'chain-failed',
  chainId,
  error: new ConflictError({ entity: 'sprint', field: 'projectId', value: 'p' }),
  at: iso(at),
});

const chainAborted = (chainId: string, at: string): ChainAbortedEvent => ({
  type: 'chain-aborted',
  chainId,
  at: iso(at),
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

    // Flush microtasks so the degradation event subscribers have run even if the bus ever
    // switches to async delivery. The in-memory bus is synchronous today; this drain insulates
    // the assertion against future bus refactors without changing what the test verifies.
    await new Promise((resolve) => setImmediate(resolve));

    // At least one drop must have fired — once degraded latches we do not re-emit.
    expect(degradations).toHaveLength(1);
    expect(degradations[0]?.reason).toBe('queue-full');

    // Subsequent overflows must NOT re-emit (the one-shot latch).
    for (let i = 0; i < 100; i++) bus.publish(makeLog(TOTAL + i));
    await new Promise((resolve) => setImmediate(resolve));
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

  it('single chain run — header + events + footer bracketed in order', async () => {
    const file = await makeFilePath();
    const bus = createInMemoryEventBus();

    const sink = startFileLogSink({ file, bus });
    bus.publish(started('chain-A', 'implement', '2026-05-20T10:00:00.000Z'));
    bus.publish(stepCompleted('chain-A', 'load-sprint', '2026-05-20T10:00:01.000Z'));
    bus.publish(stepCompleted('chain-A', 'run-task', '2026-05-20T10:00:02.000Z'));
    bus.publish(chainCompleted('chain-A', '2026-05-20T10:00:03.500Z'));
    await sink.flush();
    sink.stop();

    const written = await readFile(String(file), 'utf8');
    const lines = written.trim().split('\n');
    // header, chain-started, step-1, step-2, chain-completed, footer.
    expect(lines).toHaveLength(6);
    expect(lines[0]).toBe('=== chain-run chain-A implement started 2026-05-20T10:00:00.000Z ===');
    expect(JSON.parse(lines[1] ?? '{}')).toMatchObject({ type: 'chain-started', chainId: 'chain-A' });
    expect(JSON.parse(lines[2] ?? '{}')).toMatchObject({ type: 'chain-step-completed', elementName: 'load-sprint' });
    expect(JSON.parse(lines[3] ?? '{}')).toMatchObject({ type: 'chain-step-completed', elementName: 'run-task' });
    expect(JSON.parse(lines[4] ?? '{}')).toMatchObject({ type: 'chain-completed', chainId: 'chain-A' });
    expect(lines[5]).toBe(
      '=== chain-run chain-A implement completed 2026-05-20T10:00:03.500Z duration=3500ms steps=2 ==='
    );
  });

  it('multi-run log — two chain-run brackets each well-formed', async () => {
    const file = await makeFilePath();
    const bus = createInMemoryEventBus();

    const sink = startFileLogSink({ file, bus });
    // Run A: completed.
    bus.publish(started('chain-A', 'refine', '2026-05-20T10:00:00.000Z'));
    bus.publish(stepCompleted('chain-A', 'load', '2026-05-20T10:00:00.100Z'));
    bus.publish(chainCompleted('chain-A', '2026-05-20T10:00:00.500Z'));
    // Run B: failed.
    bus.publish(started('chain-B', 'plan', '2026-05-20T10:01:00.000Z'));
    bus.publish(stepFailed('chain-B', 'detect-scripts', '2026-05-20T10:01:00.200Z'));
    bus.publish(chainFailed('chain-B', '2026-05-20T10:01:01.000Z'));
    await sink.flush();
    sink.stop();

    const written = await readFile(String(file), 'utf8');
    const lines = written.trim().split('\n');
    // Header A, chain-started A, step A, terminal A, footer A, header B, chain-started B, step B, terminal B, footer B
    expect(lines).toHaveLength(10);
    expect(lines[0]).toBe('=== chain-run chain-A refine started 2026-05-20T10:00:00.000Z ===');
    expect(lines[4]).toBe('=== chain-run chain-A refine completed 2026-05-20T10:00:00.500Z duration=500ms steps=1 ===');
    expect(lines[5]).toBe('=== chain-run chain-B plan started 2026-05-20T10:01:00.000Z ===');
    expect(lines[9]).toBe('=== chain-run chain-B plan failed 2026-05-20T10:01:01.000Z duration=1000ms steps=1 ===');

    // NDJSON consumer can isolate event lines by skipping any line that doesn't start with `{`.
    const ndjsonLines = lines.filter((l) => l.startsWith('{'));
    expect(ndjsonLines).toHaveLength(6);
    for (const line of ndjsonLines) expect(() => JSON.parse(line)).not.toThrow();
  });

  it('crash mid-run — missing footer does not corrupt the next run header', async () => {
    const file = await makeFilePath();
    const bus = createInMemoryEventBus();

    const sink = startFileLogSink({ file, bus });
    // Run A: never gets a terminal event (simulated crash).
    bus.publish(started('chain-A', 'implement', '2026-05-20T10:00:00.000Z'));
    bus.publish(stepCompleted('chain-A', 'load-sprint', '2026-05-20T10:00:01.000Z'));
    // Run B: starts cleanly afterwards.
    bus.publish(started('chain-B', 'implement', '2026-05-20T11:00:00.000Z'));
    bus.publish(chainCompleted('chain-B', '2026-05-20T11:00:02.000Z'));
    await sink.flush();
    sink.stop();

    const written = await readFile(String(file), 'utf8');
    const lines = written.trim().split('\n');
    // Header A, chain-started A, step A, header B, chain-started B, chain-completed B, footer B.
    expect(lines).toHaveLength(7);
    expect(lines[0]).toBe('=== chain-run chain-A implement started 2026-05-20T10:00:00.000Z ===');
    // No footer for run A — the next header still appears cleanly.
    expect(lines[3]).toBe('=== chain-run chain-B implement started 2026-05-20T11:00:00.000Z ===');
    expect(lines[6]).toBe(
      '=== chain-run chain-B implement completed 2026-05-20T11:00:02.000Z duration=2000ms steps=0 ==='
    );
  });

  it('outcome attribution — completed / failed / aborted each labelled correctly', async () => {
    const cases: Array<{
      readonly kind: 'completed' | 'failed' | 'aborted';
      readonly emit: (bus: ReturnType<typeof createInMemoryEventBus>) => void;
    }> = [
      { kind: 'completed', emit: (bus) => bus.publish(chainCompleted('chain-X', '2026-05-20T10:00:01.000Z')) },
      { kind: 'failed', emit: (bus) => bus.publish(chainFailed('chain-X', '2026-05-20T10:00:01.000Z')) },
      { kind: 'aborted', emit: (bus) => bus.publish(chainAborted('chain-X', '2026-05-20T10:00:01.000Z')) },
    ];

    for (const c of cases) {
      const file = await makeFilePath();
      const bus = createInMemoryEventBus();
      const sink = startFileLogSink({ file, bus });

      bus.publish(started('chain-X', 'implement', '2026-05-20T10:00:00.000Z'));
      c.emit(bus);
      await sink.flush();
      sink.stop();

      const written = await readFile(String(file), 'utf8');
      const lines = written.trim().split('\n');
      const footer = lines[lines.length - 1] ?? '';
      expect(footer).toBe(
        `=== chain-run chain-X implement ${c.kind} 2026-05-20T10:00:01.000Z duration=1000ms steps=0 ===`
      );
    }
  });
});
