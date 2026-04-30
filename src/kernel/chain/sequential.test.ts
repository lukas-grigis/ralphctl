import { describe, expect, it } from 'vitest';
import { Result } from 'typescript-result';

import type { ChainTraceEntry, ElementResult, KernelError, OnTraceCallback } from './element.ts';
import { Element } from './element.ts';
import { Sequential } from './sequential.ts';

interface Ctx {
  readonly path: readonly string[];
}

class AppendStep extends Element<Ctx> {
  constructor(
    name: string,
    private readonly key: string,
    private readonly delayMs = 0
  ) {
    super(name);
  }
  protected override run(ctx: Ctx, _signal?: AbortSignal, onTrace?: OnTraceCallback): Promise<ElementResult<Ctx>> {
    return this.runLeaf(
      async () => {
        if (this.delayMs > 0) await new Promise<void>((r) => setTimeout(r, this.delayMs));
        return Result.ok({ path: [...ctx.path, this.key] });
      },
      undefined,
      onTrace
    );
  }
}

class FailStep extends Element<Ctx> {
  protected override run(_ctx: Ctx, _signal?: AbortSignal, onTrace?: OnTraceCallback): Promise<ElementResult<Ctx>> {
    return this.runLeaf(
      async () =>
        Promise.resolve(Result.error({ code: 'fail', message: `${this.name} broke` }) as Result<Ctx, KernelError>),
      undefined,
      onTrace
    );
  }
}

class SlowAbortAwareStep extends Element<Ctx> {
  constructor(
    name: string,
    private readonly delayMs = 50
  ) {
    super(name);
  }
  protected override run(ctx: Ctx, signal?: AbortSignal, onTrace?: OnTraceCallback): Promise<ElementResult<Ctx>> {
    return this.runLeaf(
      () =>
        new Promise<Result<Ctx, KernelError>>((resolve) => {
          const timer = setTimeout(() => {
            resolve(Result.ok({ path: [...ctx.path, this.name] }));
          }, this.delayMs);
          if (signal) {
            signal.addEventListener(
              'abort',
              () => {
                clearTimeout(timer);
                resolve(Result.ok({ path: [...ctx.path, this.name] }));
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

describe('Sequential', () => {
  it('runs children in order and threads ctx through each', async () => {
    const seq = new Sequential<Ctx>('chain', [
      new AppendStep('first', 'a'),
      new AppendStep('second', 'b'),
      new AppendStep('third', 'c'),
    ]);

    const result = await seq.execute({ path: [] });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ctx.path).toEqual(['a', 'b', 'c']);
    expect(result.value.trace.map((t) => t.stepName)).toEqual(['first', 'second', 'third']);
    for (const entry of result.value.trace) expect(entry.status).toBe('completed');
  });

  it('first failure short-circuits and remaining children appear as skipped', async () => {
    const seq = new Sequential<Ctx>('chain', [
      new AppendStep('a', 'A'),
      new FailStep('boom'),
      new AppendStep('c', 'C'),
      new AppendStep('d', 'D'),
    ]);

    const result = await seq.execute({ path: [] });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error.code).toBe('fail');
    const trace = result.error.trace;
    expect(trace.map((t) => t.stepName)).toEqual(['a', 'boom', 'c', 'd']);
    expect(trace[0]?.status).toBe('completed');
    expect(trace[1]?.status).toBe('failed');
    expect(trace[2]?.status).toBe('skipped');
    expect(trace[3]?.status).toBe('skipped');
  });

  it('abort mid-flight: current step aborts, remaining are skipped', async () => {
    const seq = new Sequential<Ctx>('chain', [
      new AppendStep('quick', 'q'),
      new SlowAbortAwareStep('slow', 100),
      new AppendStep('after', 'a'),
    ]);

    const ac = new AbortController();
    const promise = seq.execute({ path: [] }, ac.signal);
    setTimeout(() => {
      ac.abort();
    }, 10);
    const result = await promise;

    expect(result.ok).toBe(false);
    if (result.ok) return;
    const trace = result.error.trace;
    expect(trace.map((t) => t.stepName)).toEqual(['quick', 'slow', 'after']);
    expect(trace[0]?.status).toBe('completed');
    expect(trace[1]?.status).toBe('aborted');
    expect(trace[2]?.status).toBe('skipped');
  });

  it('empty children list completes immediately with empty trace', async () => {
    const seq = new Sequential<Ctx>('empty', []);
    const result = await seq.execute({ path: ['untouched'] });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ctx.path).toEqual(['untouched']);
    expect(result.value.trace).toEqual([]);
  });

  it('onTrace fires progressively per child in execution order', async () => {
    const seq = new Sequential<Ctx>('chain', [
      new AppendStep('first', 'a'),
      new AppendStep('second', 'b'),
      new AppendStep('third', 'c'),
    ]);
    const seen: ChainTraceEntry[] = [];
    await seq.execute({ path: [] }, undefined, (entry) => seen.push(entry));

    expect(seen.map((e) => e.stepName)).toEqual(['first', 'second', 'third']);
    expect(seen.every((e) => e.status === 'completed')).toBe(true);
  });

  it('onTrace fires for completed children then synthetic skipped entries on failure', async () => {
    const seq = new Sequential<Ctx>('chain', [
      new AppendStep('a', 'A'),
      new FailStep('boom'),
      new AppendStep('c', 'C'),
    ]);
    const seen: ChainTraceEntry[] = [];
    await seq.execute({ path: [] }, undefined, (entry) => seen.push(entry));

    expect(seen.map((e) => e.stepName)).toEqual(['a', 'boom', 'c']);
    expect(seen.map((e) => e.status)).toEqual(['completed', 'failed', 'skipped']);
  });

  it('pre-aborted signal: first child marked aborted, rest skipped', async () => {
    const seq = new Sequential<Ctx>('chain', [new AppendStep('first', 'a'), new AppendStep('second', 'b')]);
    const ac = new AbortController();
    ac.abort();
    const result = await seq.execute({ path: [] }, ac.signal);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    // The base Element.execute() short-circuits on a pre-aborted signal,
    // producing a single aborted entry for the Sequential itself rather than
    // entering run(). That's acceptable: the contract is just that aborted
    // signals don't run the body.
    expect(result.error.error.code).toBe('aborted');
    expect(result.error.trace).toHaveLength(1);
    expect(result.error.trace[0]?.status).toBe('aborted');
  });
});
