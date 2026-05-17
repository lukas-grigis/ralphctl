import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { AbortError } from '@src/domain/value/error/abort-error.ts';
import { ValidationError } from '@src/domain/value/error/validation-error.ts';
import type { TraceEntry } from '@src/application/chain/trace.ts';
import { leaf, type LeafUseCase } from '@src/application/chain/build/leaf.ts';

interface Ctx {
  readonly count: number;
}

const inc: LeafUseCase<{ readonly current: number }, { readonly next: number }> = {
  async execute(input) {
    return Result.ok({ next: input.current + 1 });
  },
};

const failing: LeafUseCase<unknown, unknown> = {
  async execute() {
    return Result.error(new ValidationError({ field: 'x', value: 0, message: 'boom' }));
  },
};

describe('leaf', () => {
  it('threads ctx through input/output mappers on success', async () => {
    const el = leaf<Ctx, { current: number }, { next: number }>('inc', {
      useCase: inc,
      input: (c) => ({ current: c.count }),
      output: (c, o) => ({ ...c, count: o.next }),
    });

    const result = await el.execute({ count: 1 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.ctx).toEqual({ count: 2 });
      expect(result.value.trace).toHaveLength(1);
      expect(result.value.trace[0]?.elementName).toBe('inc');
      expect(result.value.trace[0]?.status).toBe('completed');
    }
  });

  it('returns the use-case error verbatim with a failed trace entry', async () => {
    const el = leaf<Ctx, unknown, unknown>('boom', {
      useCase: failing,
      input: () => undefined,
      output: (c) => c,
    });

    const result = await el.execute({ count: 0 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.error).toBeInstanceOf(ValidationError);
      expect(result.error.trace[0]?.status).toBe('failed');
      expect(result.error.trace[0]?.error).toBeInstanceOf(ValidationError);
    }
  });

  it('short-circuits to aborted when signal is already tripped', async () => {
    let called = false;
    const el = leaf<Ctx, unknown, unknown>('inc', {
      useCase: {
        async execute() {
          called = true;
          return Result.ok(undefined);
        },
      },
      input: () => undefined,
      output: (c) => c,
    });

    const ac = new AbortController();
    ac.abort();
    const result = await el.execute({ count: 0 }, ac.signal);

    expect(called).toBe(false);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.error).toBeInstanceOf(AbortError);
  });

  it('returns aborted when signal trips during use-case execution', async () => {
    const ac = new AbortController();
    const el = leaf<Ctx, unknown, unknown>('slow', {
      useCase: {
        async execute() {
          ac.abort();
          return Result.ok(undefined);
        },
      },
      input: () => undefined,
      output: (c) => c,
    });

    const result = await el.execute({ count: 0 }, ac.signal);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.error).toBeInstanceOf(AbortError);
      expect(result.error.trace[0]?.status).toBe('aborted');
    }
  });

  it('emits its trace entry through onTrace exactly once', async () => {
    const emitted: TraceEntry[] = [];
    const el = leaf<Ctx, { current: number }, { next: number }>('inc', {
      useCase: inc,
      input: (c) => ({ current: c.count }),
      output: (c, o) => ({ ...c, count: o.next }),
    });

    await el.execute({ count: 1 }, undefined, (e) => emitted.push(e));
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.elementName).toBe('inc');
  });
});
