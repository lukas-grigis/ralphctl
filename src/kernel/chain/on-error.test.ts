import { describe, expect, it, vi } from 'vitest';
import { Result } from 'typescript-result';

import type { ChainTraceEntry, ElementResult, KernelError, OnTraceCallback } from './element.ts';
import { Element } from './element.ts';
import { OnError } from './on-error.ts';

interface Ctx {
  readonly tag: string;
}

class OkStep extends Element<Ctx> {
  constructor(
    name: string,
    private readonly tag: string
  ) {
    super(name);
  }
  protected override run(_ctx: Ctx, _signal?: AbortSignal, onTrace?: OnTraceCallback): Promise<ElementResult<Ctx>> {
    return this.runLeaf(
      async () => Promise.resolve(Result.ok({ tag: this.tag }) as Result<Ctx, KernelError>),
      undefined,
      onTrace
    );
  }
}

class FailStep extends Element<Ctx> {
  constructor(
    name: string,
    private readonly err: KernelError
  ) {
    super(name);
  }
  protected override run(_ctx: Ctx, _signal?: AbortSignal, onTrace?: OnTraceCallback): Promise<ElementResult<Ctx>> {
    return this.runLeaf(
      async () => Promise.resolve(Result.error(this.err) as Result<Ctx, KernelError>),
      undefined,
      onTrace
    );
  }
}

describe('OnError', () => {
  it('passes through child success without invoking the fallback', async () => {
    const fallback = new OkStep('fallback', 'fallback-ran');
    const fallbackSpy = vi.spyOn(fallback, 'execute');
    const wrapper = new OnError<Ctx>(new OkStep('child', 'child-ran'), { fallback });

    const result = await wrapper.execute({ tag: 'init' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ctx.tag).toBe('child-ran');
    expect(fallbackSpy).not.toHaveBeenCalled();
  });

  it('runs fallback on child failure when catchIf matches', async () => {
    const err: KernelError = { code: 'oops', message: 'broken' };
    const fallback = new OkStep('fallback', 'fallback-ran');
    const wrapper = new OnError<Ctx>(new FailStep('child', err), {
      fallback,
      catchIf: (e) => e.code === 'oops',
    });

    const result = await wrapper.execute({ tag: 'init' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ctx.tag).toBe('fallback-ran');
    // Trace contains both the failed child entry and the fallback's entry.
    const names = result.value.trace.map((t) => t.stepName);
    const statuses = result.value.trace.map((t) => t.status);
    expect(names).toEqual(['child', 'fallback']);
    expect(statuses).toEqual(['failed', 'completed']);
  });

  it('default catchIf catches every error', async () => {
    const err: KernelError = { code: 'whatever', message: 'broken' };
    const fallback = new OkStep('fallback', 'fallback-ran');
    const wrapper = new OnError<Ctx>(new FailStep('child', err), { fallback });

    const result = await wrapper.execute({ tag: 'init' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ctx.tag).toBe('fallback-ran');
  });

  it('propagates the original error when catchIf returns false', async () => {
    const err: KernelError = { code: 'fatal', message: 'do not catch' };
    const fallback = new OkStep('fallback', 'fallback-ran');
    const fallbackSpy = vi.spyOn(fallback, 'execute');
    const wrapper = new OnError<Ctx>(new FailStep('child', err), {
      fallback,
      catchIf: (e) => e.code === 'recoverable',
    });

    const result = await wrapper.execute({ tag: 'init' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error).toBe(err);
    expect(result.error.trace.map((t) => t.stepName)).toEqual(['child']);
    expect(fallbackSpy).not.toHaveBeenCalled();
  });

  it('onTrace fires for both child failure and fallback success', async () => {
    const err: KernelError = { code: 'oops', message: 'broken' };
    const fallback = new OkStep('fallback', 'fallback-ran');
    const wrapper = new OnError<Ctx>(new FailStep('child', err), { fallback });

    const seen: ChainTraceEntry[] = [];
    await wrapper.execute({ tag: 'init' }, undefined, (entry) => seen.push(entry));

    expect(seen.map((e) => e.stepName)).toEqual(['child', 'fallback']);
    expect(seen.map((e) => e.status)).toEqual(['failed', 'completed']);
  });

  it('propagates fallback failure (no recursive catch)', async () => {
    const err1: KernelError = { code: 'first', message: 'child broke' };
    const err2: KernelError = { code: 'second', message: 'fallback also broke' };
    const wrapper = new OnError<Ctx>(new FailStep('child', err1), {
      fallback: new FailStep('fallback', err2),
    });

    const result = await wrapper.execute({ tag: 'init' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error).toBe(err2);
    const trace = result.error.trace;
    expect(trace.map((t) => t.stepName)).toEqual(['child', 'fallback']);
    expect(trace.map((t) => t.status)).toEqual(['failed', 'failed']);
  });
});
