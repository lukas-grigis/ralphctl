import { describe, expect, it } from 'vitest';
import { Result } from 'typescript-result';

import type { ChainTraceEntry, ElementResult, KernelError, OnTraceCallback } from './element.ts';
import { Element } from './element.ts';

interface Ctx {
  readonly value: number;
}

/** Test subclass: succeeds, increments value, takes a measurable amount of time. */
class OkElement extends Element<Ctx> {
  protected override async run(ctx: Ctx): Promise<ElementResult<Ctx>> {
    return this.runLeaf(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      return Result.ok({ value: ctx.value + 1 });
    });
  }
}

class FailElement extends Element<Ctx> {
  constructor(
    name: string,
    private readonly err: KernelError = { code: 'boom', message: 'failed on purpose' }
  ) {
    super(name);
  }
  protected override run(): Promise<ElementResult<Ctx>> {
    return this.runLeaf(async () => Promise.resolve(Result.error(this.err) as Result<Ctx, KernelError>));
  }
}

class ThrowElement extends Element<Ctx> {
  protected override run(): Promise<ElementResult<Ctx>> {
    throw new Error('synchronous boom');
  }
}

class AbortAwareElement extends Element<Ctx> {
  protected override run(_ctx: Ctx, signal?: AbortSignal): Promise<ElementResult<Ctx>> {
    return this.runLeaf(
      () =>
        new Promise<Result<Ctx, KernelError>>((resolve) => {
          const timer = setTimeout(() => {
            resolve(Result.ok({ value: 99 }));
          }, 50);
          if (signal) {
            signal.addEventListener(
              'abort',
              () => {
                clearTimeout(timer);
                resolve(Result.ok({ value: 99 }));
              },
              { once: true }
            );
          }
        }),
      signal
    );
  }
}

describe('Element (abstract base)', () => {
  it('success path produces a single completed trace entry with non-zero duration', async () => {
    const el = new OkElement('ok');
    const result = await el.execute({ value: 0 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ctx).toEqual({ value: 1 });
    expect(result.value.trace).toHaveLength(1);
    const entry = result.value.trace[0];
    expect(entry?.stepName).toBe('ok');
    expect(entry?.status).toBe('completed');
    expect(entry?.durationMs).toBeGreaterThan(0);
    expect(entry?.error).toBeUndefined();
  });

  it('failure path produces a single failed trace entry with the error attached', async () => {
    const customErr: KernelError = { code: 'oops', message: 'nope' };
    const el = new FailElement('boom', customErr);
    const result = await el.execute({ value: 0 });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error).toBe(customErr);
    expect(result.error.trace).toHaveLength(1);
    expect(result.error.trace[0]).toMatchObject({
      stepName: 'boom',
      status: 'failed',
      error: customErr,
    });
  });

  it('converts a thrown synchronous error in run() into a failed result', async () => {
    const el = new ThrowElement('throws');
    const result = await el.execute({ value: 0 });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error.code).toBe('unexpected');
    expect(result.error.error.message).toBe('synchronous boom');
    expect(result.error.trace).toHaveLength(1);
    expect(result.error.trace[0]?.status).toBe('failed');
  });

  it('pre-aborted signal yields an aborted trace entry without invoking run()', async () => {
    const el = new OkElement('ok');
    const ac = new AbortController();
    ac.abort();
    const result = await el.execute({ value: 0 }, ac.signal);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error.code).toBe('aborted');
    expect(result.error.trace).toHaveLength(1);
    expect(result.error.trace[0]?.status).toBe('aborted');
  });

  it('forwards onTrace through runLeaf so leaves emit progressively', async () => {
    class ProgressiveOk extends Element<Ctx> {
      protected override run(ctx: Ctx, _signal?: AbortSignal, onTrace?: OnTraceCallback): Promise<ElementResult<Ctx>> {
        return this.runLeaf(() => Promise.resolve(Result.ok({ value: ctx.value + 1 })), undefined, onTrace);
      }
    }
    const el = new ProgressiveOk('progressive');
    const seen: ChainTraceEntry[] = [];
    const result = await el.execute({ value: 0 }, undefined, (entry) => seen.push(entry));

    expect(result.ok).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.stepName).toBe('progressive');
    expect(seen[0]?.status).toBe('completed');
  });

  it('replays trace entries via onTrace as a fallback when run() ignores the param', async () => {
    // Subclass uses the OLD `(ctx, signal)` signature and constructs its
    // own trace without going through runLeaf or onTrace. The base must
    // still surface the entries through onTrace for backwards-compat.
    class LegacyElement extends Element<Ctx> {
      protected override run(): Promise<ElementResult<Ctx>> {
        return Promise.resolve(
          Result.ok({
            ctx: { value: 42 },
            trace: [{ stepName: 'legacy', status: 'completed' as const, durationMs: 1 }],
          })
        );
      }
    }
    const el = new LegacyElement('legacy');
    const seen: ChainTraceEntry[] = [];
    await el.execute({ value: 0 }, undefined, (entry) => seen.push(entry));

    expect(seen).toHaveLength(1);
    expect(seen[0]?.stepName).toBe('legacy');
  });

  it('mid-flight abort produces an aborted trace entry from runLeaf', async () => {
    const el = new AbortAwareElement('abortive');
    const ac = new AbortController();
    const promise = el.execute({ value: 0 }, ac.signal);
    setTimeout(() => {
      ac.abort();
    }, 10);
    const result = await promise;

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error.code).toBe('aborted');
    expect(result.error.trace[0]?.status).toBe('aborted');
  });
});
