import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { AbortError } from '@src/domain/value/error/abort-error.ts';
import { ValidationError } from '@src/domain/value/error/validation-error.ts';
import type { Element } from '@src/application/chain/element.ts';
import type { TraceEntry } from '@src/application/chain/trace.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';
import { sequential } from '@src/application/chain/build/sequential.ts';

interface Ctx {
  readonly trail: readonly string[];
}

const tag = (name: string): Element<Ctx> =>
  leaf<Ctx, Ctx, Ctx>(name, {
    useCase: {
      async execute(input) {
        return Result.ok({ trail: [...input.trail, name] });
      },
    },
    input: (c) => c,
    output: (_c, o) => o,
  });

const fail = (name: string): Element<Ctx> =>
  leaf<Ctx, unknown, unknown>(name, {
    useCase: {
      async execute() {
        return Result.error(new ValidationError({ field: name, value: 0, message: `${name} failed` }));
      },
    },
    input: () => undefined,
    output: (c) => c,
  });

describe('sequential', () => {
  it('returns the input ctx unchanged when there are no children', async () => {
    const result = await sequential<Ctx>('empty', []).execute({ trail: ['start'] });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.ctx).toEqual({ trail: ['start'] });
      expect(result.value.trace).toHaveLength(0);
    }
  });

  it('threads ctx through children and accumulates the trace', async () => {
    const chain = sequential<Ctx>('all', [tag('a'), tag('b'), tag('c')]);
    const result = await chain.execute({ trail: [] });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.ctx).toEqual({ trail: ['a', 'b', 'c'] });
      expect(result.value.trace.map((e) => e.elementName)).toEqual(['a', 'b', 'c']);
      expect(result.value.trace.every((e) => e.status === 'completed')).toBe(true);
    }
  });

  it('stops at the first failure and marks remaining children skipped', async () => {
    const chain = sequential<Ctx>('mid-fail', [tag('a'), fail('b'), tag('c')]);
    const result = await chain.execute({ trail: [] });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.error).toBeInstanceOf(ValidationError);
      const statuses = result.error.trace.map((e) => `${e.elementName}:${e.status}`);
      expect(statuses).toEqual(['a:completed', 'b:failed', 'c:skipped']);
    }
  });

  it('returns aborted when signal is tripped before execution begins', async () => {
    const ac = new AbortController();
    ac.abort();
    const chain = sequential<Ctx>('pre-abort', [tag('a')]);
    const result = await chain.execute({ trail: [] }, ac.signal);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.error).toBeInstanceOf(AbortError);
  });

  it('aborts the in-flight child and skips the rest when signal trips during execution', async () => {
    const ac = new AbortController();
    const trippedDuringA = leaf<Ctx, Ctx, Ctx>('a', {
      useCase: {
        async execute(input) {
          ac.abort();
          return Result.ok({ trail: [...input.trail, 'a'] });
        },
      },
      input: (c) => c,
      output: (_c, o) => o,
    });

    const chain = sequential<Ctx>('mid-abort', [trippedDuringA, tag('b'), tag('c')]);
    const result = await chain.execute({ trail: [] }, ac.signal);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.error).toBeInstanceOf(AbortError);
      const statuses = result.error.trace.map((e) => `${e.elementName}:${e.status}`);
      expect(statuses).toEqual(['a:aborted', 'b:skipped', 'c:skipped']);
    }
  });

  it('forwards onTrace progressively as children settle', async () => {
    const emitted: TraceEntry[] = [];
    const chain = sequential<Ctx>('all', [tag('a'), tag('b')]);
    await chain.execute({ trail: [] }, undefined, (e) => emitted.push(e));

    expect(emitted.map((e) => e.elementName)).toEqual(['a', 'b']);
  });
});
