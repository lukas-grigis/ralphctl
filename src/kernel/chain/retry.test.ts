import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Result } from 'typescript-result';

import type { ChainTraceEntry, ElementResult, KernelError, OnTraceCallback } from './element.ts';
import { Element } from './element.ts';
import { Retry } from './retry.ts';

interface Ctx {
  readonly attempts: number;
}

class CountingStep extends Element<Ctx> {
  public calls = 0;
  constructor(
    name: string,
    private readonly outcomes: readonly ('ok' | KernelError)[]
  ) {
    super(name);
  }
  protected override run(ctx: Ctx, _signal?: AbortSignal, onTrace?: OnTraceCallback): Promise<ElementResult<Ctx>> {
    return this.runLeaf(
      async () => {
        const i = this.calls++;
        const out = this.outcomes[i] ?? 'ok';
        if (out === 'ok') {
          return Result.ok({ attempts: ctx.attempts + 1 });
        }
        return Promise.resolve(Result.error(out) as Result<Ctx, KernelError>);
      },
      undefined,
      onTrace
    );
  }
}

describe('Retry', () => {
  it('succeeds on first attempt: single trace entry', async () => {
    const child = new CountingStep('do-it', ['ok']);
    const retry = new Retry<Ctx>(child, {
      maxAttempts: 3,
      backoff: 'fixed',
      initialDelayMs: 10,
      retryOn: () => true,
    });

    const result = await retry.execute({ attempts: 0 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(child.calls).toBe(1);
    expect(result.value.trace).toHaveLength(1);
    expect(result.value.trace[0]?.status).toBe('completed');
    expect(result.value.trace[0]?.stepName).toBe('do-it#attempt-1');
  });

  it('succeeds on attempt N: N trace entries, last is completed', async () => {
    const err: KernelError = { code: 'transient', message: 'try again' };
    const child = new CountingStep('do-it', [err, err, 'ok']);
    const retry = new Retry<Ctx>(child, {
      maxAttempts: 5,
      backoff: 'fixed',
      initialDelayMs: 0,
      retryOn: () => true,
    });

    const result = await retry.execute({ attempts: 0 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(child.calls).toBe(3);
    expect(result.value.trace).toHaveLength(3);
    expect(result.value.trace[0]?.status).toBe('failed');
    expect(result.value.trace[1]?.status).toBe('failed');
    expect(result.value.trace[2]?.status).toBe('completed');
    expect(result.value.trace.map((t) => t.stepName)).toEqual([
      'do-it#attempt-1',
      'do-it#attempt-2',
      'do-it#attempt-3',
    ]);
  });

  it('exhausts maxAttempts: all entries failed and final error propagates', async () => {
    const err: KernelError = { code: 'always-fails', message: 'no luck' };
    const child = new CountingStep('do-it', [err, err, err]);
    const retry = new Retry<Ctx>(child, {
      maxAttempts: 3,
      backoff: 'fixed',
      initialDelayMs: 0,
      retryOn: () => true,
    });

    const result = await retry.execute({ attempts: 0 });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(child.calls).toBe(3);
    expect(result.error.trace).toHaveLength(3);
    for (const entry of result.error.trace) expect(entry.status).toBe('failed');
    expect(result.error.error).toBe(err);
  });

  it('retryOn=false short-circuits: single failure trace entry', async () => {
    const err: KernelError = { code: 'fatal', message: 'do not retry' };
    const child = new CountingStep('do-it', [err]);
    const retry = new Retry<Ctx>(child, {
      maxAttempts: 5,
      backoff: 'fixed',
      initialDelayMs: 0,
      retryOn: (e) => e.code !== 'fatal',
    });

    const result = await retry.execute({ attempts: 0 });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(child.calls).toBe(1);
    expect(result.error.trace).toHaveLength(1);
    expect(result.error.error.code).toBe('fatal');
  });

  it('onTrace fires once per attempt with the renamed step name', async () => {
    const err: KernelError = { code: 'transient', message: 'try again' };
    const child = new CountingStep('do-it', [err, err, 'ok']);
    const retry = new Retry<Ctx>(child, {
      maxAttempts: 5,
      backoff: 'fixed',
      initialDelayMs: 0,
      retryOn: () => true,
    });

    const seen: ChainTraceEntry[] = [];
    await retry.execute({ attempts: 0 }, undefined, (entry) => seen.push(entry));

    expect(seen.map((e) => e.stepName)).toEqual(['do-it#attempt-1', 'do-it#attempt-2', 'do-it#attempt-3']);
    expect(seen.map((e) => e.status)).toEqual(['failed', 'failed', 'completed']);
  });

  it('rejects maxAttempts < 1 at construction time', () => {
    const child = new CountingStep('x', []);
    expect(
      () =>
        new Retry<Ctx>(child, {
          maxAttempts: 0,
          backoff: 'fixed',
          initialDelayMs: 1,
          retryOn: () => true,
        })
    ).toThrow(/maxAttempts/);
  });
});

describe('Retry — exponential backoff timing', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('exponential backoff: initial * 2^(attempt-1)', async () => {
    const err: KernelError = { code: 'transient', message: 'wait' };
    const child = new CountingStep('do-it', [err, err, 'ok']);
    const retry = new Retry<Ctx>(child, {
      maxAttempts: 5,
      backoff: 'exponential',
      initialDelayMs: 100,
      retryOn: () => true,
    });

    const promise = retry.execute({ attempts: 0 });

    // Attempt 1 runs immediately and fails.
    await vi.advanceTimersByTimeAsync(0);
    expect(child.calls).toBe(1);

    // Backoff after attempt 1 = 100ms.
    await vi.advanceTimersByTimeAsync(99);
    expect(child.calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    // Attempt 2 runs and fails.
    await vi.advanceTimersByTimeAsync(0);
    expect(child.calls).toBe(2);

    // Backoff after attempt 2 = 200ms.
    await vi.advanceTimersByTimeAsync(199);
    expect(child.calls).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    // Attempt 3 runs.
    await vi.advanceTimersByTimeAsync(0);
    expect(child.calls).toBe(3);

    const result = await promise;
    expect(result.ok).toBe(true);
  });
});
