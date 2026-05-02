import { describe, expect, it } from 'vitest';
import { Result } from 'typescript-result';

import type { ChainTraceEntry, ElementResult, KernelError, OnTraceCallback } from './element.ts';
import { Element } from './element.ts';
import { Parallel } from './parallel.ts';

interface Ctx {
  readonly count: number;
  readonly tag?: string;
}

const sumReducer = (children: readonly Ctx[]): Ctx => ({
  count: children.reduce((acc, c) => acc + c.count, 0),
});

class TimedAddStep extends Element<Ctx> {
  constructor(
    name: string,
    private readonly add: number,
    private readonly delayMs: number,
    private readonly counter: { active: number; max: number }
  ) {
    super(name);
  }
  protected override run(ctx: Ctx, signal?: AbortSignal, onTrace?: OnTraceCallback): Promise<ElementResult<Ctx>> {
    return this.runLeaf(
      () =>
        new Promise<Result<Ctx, KernelError>>((resolve) => {
          this.counter.active += 1;
          if (this.counter.active > this.counter.max) this.counter.max = this.counter.active;
          const timer = setTimeout(() => {
            this.counter.active -= 1;
            resolve(Result.ok({ count: ctx.count + this.add }));
          }, this.delayMs);
          if (signal) {
            signal.addEventListener(
              'abort',
              () => {
                clearTimeout(timer);
                this.counter.active -= 1;
                resolve(Result.ok({ count: ctx.count + this.add }));
              },
              { once: true }
            );
          }
        }),
      signal,
      onTrace
    );
  }
}

class FailAfterStep extends Element<Ctx> {
  constructor(
    name: string,
    private readonly delayMs: number
  ) {
    super(name);
  }
  protected override run(_ctx: Ctx, _signal?: AbortSignal, onTrace?: OnTraceCallback): Promise<ElementResult<Ctx>> {
    return this.runLeaf(
      () =>
        new Promise<Result<Ctx, KernelError>>((resolve) => {
          setTimeout(() => {
            resolve(Result.error({ code: 'kaboom', message: `${this.name} failed` }));
          }, this.delayMs);
        }),
      undefined,
      onTrace
    );
  }
}

class InstantOk extends Element<Ctx> {
  constructor(
    name: string,
    private readonly add: number
  ) {
    super(name);
  }
  protected override run(ctx: Ctx, _signal?: AbortSignal, onTrace?: OnTraceCallback): Promise<ElementResult<Ctx>> {
    return this.runLeaf(
      async () => Promise.resolve(Result.ok({ count: ctx.count + this.add }) as Result<Ctx, KernelError>),
      undefined,
      onTrace
    );
  }
}

describe('Parallel', () => {
  it('honours the concurrency cap', async () => {
    const counter = { active: 0, max: 0 };
    const children = Array.from({ length: 6 }, (_, i) => new TimedAddStep(`c${String(i)}`, 1, 20, counter));
    const par = new Parallel<Ctx>('fan-out', children, {
      concurrency: 2,
      failureMode: 'fail-fast',
      reduce: sumReducer,
    });

    const result = await par.execute({ count: 0 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ctx.count).toBe(6);
    expect(counter.max).toBeLessThanOrEqual(2);
    expect(counter.max).toBeGreaterThanOrEqual(1);
  });

  it('fail-fast aborts siblings — they appear as aborted in the trace', async () => {
    const counter = { active: 0, max: 0 };
    const par = new Parallel<Ctx>(
      'fan-out',
      [
        new FailAfterStep('quick-fail', 5),
        new TimedAddStep('slow-1', 1, 50, counter),
        new TimedAddStep('slow-2', 1, 50, counter),
      ],
      {
        concurrency: 3,
        failureMode: 'fail-fast',
        reduce: sumReducer,
      }
    );

    const result = await par.execute({ count: 0 });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error.code).toBe('kaboom');

    // The fail-fast trigger names appear in the trace; siblings who saw the
    // abort report 'aborted' (via runLeaf observing internal signal).
    const slowEntries = result.error.trace.filter((t) => t.stepName.startsWith('slow-'));
    expect(slowEntries.length).toBe(2);
    for (const entry of slowEntries) expect(entry.status).toBe('aborted');
  });

  it('collect-all runs every child to completion even when one fails', async () => {
    const counter = { active: 0, max: 0 };
    const par = new Parallel<Ctx>(
      'fan-out',
      [new TimedAddStep('a', 1, 5, counter), new FailAfterStep('b', 5), new TimedAddStep('c', 2, 5, counter)],
      {
        concurrency: 3,
        failureMode: 'collect-all',
        reduce: sumReducer,
      }
    );

    const result = await par.execute({ count: 0 });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Trace should contain entries for all three children.
    const names = result.error.trace.map((t) => t.stepName).sort();
    expect(names).toStrictEqual(['a', 'b', 'c']);
    const a = result.error.trace.find((t) => t.stepName === 'a');
    const b = result.error.trace.find((t) => t.stepName === 'b');
    const c = result.error.trace.find((t) => t.stepName === 'c');
    expect(a?.status).toBe('completed');
    expect(b?.status).toBe('failed');
    expect(c?.status).toBe('completed');
    expect(result.error.error.code).toBe('kaboom');
  });

  it('reduce merges per-child success contexts into a single ctx', async () => {
    const par = new Parallel<Ctx>('merge', [new InstantOk('a', 10), new InstantOk('b', 20), new InstantOk('c', 30)], {
      concurrency: 3,
      failureMode: 'fail-fast',
      reduce: sumReducer,
    });
    const result = await par.execute({ count: 0 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ctx.count).toBe(60);
  });

  it('trace entries appear in completion order', async () => {
    const counter = { active: 0, max: 0 };
    // Three children with different delays — they must complete fastest-first.
    const par = new Parallel<Ctx>(
      'order',
      [
        new TimedAddStep('slow', 1, 30, counter),
        new TimedAddStep('medium', 1, 15, counter),
        new TimedAddStep('fast', 1, 5, counter),
      ],
      {
        concurrency: 3,
        failureMode: 'fail-fast',
        reduce: sumReducer,
      }
    );
    const result = await par.execute({ count: 0 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.trace.map((t) => t.stepName)).toStrictEqual(['fast', 'medium', 'slow']);
  });

  it('empty children list reduces an empty array and returns immediately', async () => {
    const par = new Parallel<Ctx>('nothing', [], {
      concurrency: 2,
      failureMode: 'fail-fast',
      reduce: () => ({ count: 999 }),
    });
    const result = await par.execute({ count: 0 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ctx.count).toBe(999);
    expect(result.value.trace).toStrictEqual([]);
  });

  it('onTrace fires for each child in completion order (fastest first)', async () => {
    const counter = { active: 0, max: 0 };
    const par = new Parallel<Ctx>(
      'order',
      [
        new TimedAddStep('slow', 1, 30, counter),
        new TimedAddStep('medium', 1, 15, counter),
        new TimedAddStep('fast', 1, 5, counter),
      ],
      {
        concurrency: 3,
        failureMode: 'fail-fast',
        reduce: sumReducer,
      }
    );
    const seen: ChainTraceEntry[] = [];
    await par.execute({ count: 0 }, undefined, (entry) => seen.push(entry));

    expect(seen.map((e) => e.stepName)).toStrictEqual(['fast', 'medium', 'slow']);
    expect(seen.every((e) => e.status === 'completed')).toBe(true);
  });

  it('onTrace receives synthetic aborted entries for fail-fast siblings that never started', async () => {
    const counter = { active: 0, max: 0 };
    const par = new Parallel<Ctx>(
      'fan-out',
      [
        new FailAfterStep('quick-fail', 5),
        new TimedAddStep('slow-1', 1, 50, counter),
        new TimedAddStep('slow-2', 1, 50, counter),
        new InstantOk('not-started-1', 1),
        new InstantOk('not-started-2', 1),
      ],
      {
        concurrency: 1, // serialised so the fail-fast trips before later siblings start
        failureMode: 'fail-fast',
        reduce: sumReducer,
      }
    );
    const seen: ChainTraceEntry[] = [];
    await par.execute({ count: 0 }, undefined, (entry) => seen.push(entry));

    // All five children appear in onTrace; later ones are 'aborted'.
    const names = seen.map((e) => e.stepName);
    expect(names).toContain('quick-fail');
    expect(names).toContain('not-started-1');
    expect(names).toContain('not-started-2');
    const notStarted = seen.filter((e) => e.stepName.startsWith('not-started-'));
    expect(notStarted.length).toBe(2);
    for (const e of notStarted) expect(e.status).toBe('aborted');
  });

  it('rejects concurrency < 1 at construction time', () => {
    expect(
      () => new Parallel<Ctx>('bad', [], { concurrency: 0, failureMode: 'fail-fast', reduce: sumReducer })
    ).toThrow(/concurrency/);
  });
});
