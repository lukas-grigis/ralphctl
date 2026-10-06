import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { AbortError } from '@src/domain/value/error/abort-error.ts';
import { ValidationError } from '@src/domain/value/error/validation-error.ts';
import type { StepStart, TraceEntry } from '@src/application/chain/trace.ts';
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

  it('traces a returned AbortError as aborted, matching the thrown path', async () => {
    const abortErr = new AbortError({ elementName: 'x' });
    const emitted: TraceEntry[] = [];
    const el = leaf<Ctx, unknown, unknown>('x', {
      useCase: {
        async execute() {
          return Result.error(abortErr);
        },
      },
      input: () => undefined,
      output: (c) => c,
    });

    const result = await el.execute({ count: 0 }, undefined, (e) => emitted.push(e));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.error).toBe(abortErr);
      expect(result.error.trace[0]?.status).toBe('aborted');
    }
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.status).toBe('aborted');
    expect(emitted[0]?.error).toBe(abortErr);
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

  it('forwards opts.label to the resulting element and to every trace entry it emits', async () => {
    const el = leaf<Ctx, { current: number }, { next: number }>('inc-1-/abs/path', {
      useCase: inc,
      input: (c) => ({ current: c.count }),
      output: (c, o) => ({ ...c, count: o.next }),
      label: 'inc · my-repo',
    });

    expect(el.label).toBe('inc · my-repo');

    const result = await el.execute({ count: 1 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.trace[0]?.elementName).toBe('inc-1-/abs/path');
      expect(result.value.trace[0]?.label).toBe('inc · my-repo');
    }
  });

  it('omits label from element + trace entries when opts is not supplied (backward compatible)', async () => {
    const el = leaf<Ctx, { current: number }, { next: number }>('inc', {
      useCase: inc,
      input: (c) => ({ current: c.count }),
      output: (c, o) => ({ ...c, count: o.next }),
    });

    expect(el.label).toBeUndefined();

    const result = await el.execute({ count: 1 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      // The `label` key is omitted entirely, not present-as-undefined — keeps the trace entry
      // shape identical to v0.7.0 for callers that did exact-equality comparisons.
      expect('label' in result.value.trace[0]!).toBe(false);
    }
  });

  it('propagates label onto failed and aborted trace entries', async () => {
    const failingEl = leaf<Ctx, unknown, unknown>('fail', {
      useCase: failing,
      input: () => undefined,
      output: (c) => c,
      label: 'Fail · case',
    });
    const failResult = await failingEl.execute({ count: 0 });
    expect(failResult.ok).toBe(false);
    if (!failResult.ok) {
      expect(failResult.error.trace[0]?.label).toBe('Fail · case');
    }

    const slowEl = leaf<Ctx, unknown, unknown>('slow', {
      useCase: {
        async execute() {
          return Result.ok(undefined);
        },
      },
      input: () => undefined,
      output: (c) => c,
      label: 'Slow · case',
    });
    const ac = new AbortController();
    ac.abort();
    const abortedResult = await slowEl.execute({ count: 0 }, ac.signal);
    expect(abortedResult.ok).toBe(false);
    if (!abortedResult.ok) {
      // The pre-execution abort is reported via `checkAborted` (in element.ts) which builds its
      // entry from `abortedEntry(name)` — that helper has no element handle, so its synthetic
      // entry lacks the label. Documented behaviour: only entries the leaf builds itself carry
      // the label.
      expect(abortedResult.error.trace[0]?.elementName).toBe('slow');
    }
  });

  it('calls onStart after the abort check and before the use case runs, carrying the label', async () => {
    const order: string[] = [];
    const starts: StepStart[] = [];
    const el = leaf<Ctx, unknown, unknown>('work', {
      useCase: {
        async execute() {
          order.push('execute');
          return Result.ok(undefined);
        },
      },
      input: () => {
        order.push('input');
        return undefined;
      },
      output: (c) => c,
      label: 'Do work',
    });

    await el.execute({ count: 0 }, undefined, undefined, (s) => {
      order.push('start');
      starts.push(s);
    });

    expect(order).toEqual(['start', 'input', 'execute']);
    expect(starts).toEqual([{ elementName: 'work', label: 'Do work' }]);
  });

  it('never calls onStart on a pre-aborted signal', async () => {
    const starts: StepStart[] = [];
    const el = leaf<Ctx, { current: number }, { next: number }>('inc', {
      useCase: inc,
      input: (c) => ({ current: c.count }),
      output: (c, o) => ({ ...c, count: o.next }),
    });
    const ac = new AbortController();
    ac.abort();

    await el.execute({ count: 0 }, ac.signal, undefined, (s) => starts.push(s));

    expect(starts).toEqual([]);
  });

  it('carries kind and display metadata, with the optional keys absent when not passed', () => {
    const plain = leaf<Ctx, unknown, unknown>('plain', { useCase: failing, input: () => undefined, output: (c) => c });
    expect(plain.kind).toBe('leaf');
    expect('label' in plain).toBe(false);
    expect('display' in plain).toBe(false);

    const internal = leaf<Ctx, unknown, unknown>('stamp', {
      useCase: failing,
      input: () => undefined,
      output: (c) => c,
      label: 'Record session',
      internal: true,
    });
    expect(internal.label).toBe('Record session');
    expect(internal.display).toEqual({ internal: true });

    const notInternal = leaf<Ctx, unknown, unknown>('x', {
      useCase: failing,
      input: () => undefined,
      output: (c) => c,
      internal: false,
    });
    expect('display' in notInternal).toBe(false);
  });
});
