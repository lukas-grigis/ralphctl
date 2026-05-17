import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { ValidationError } from '@src/domain/value/error/validation-error.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';
import { loop } from '@src/application/chain/build/loop.ts';
import { sequential } from '@src/application/chain/build/sequential.ts';

interface Ctx {
  readonly count: number;
  readonly trail: readonly string[];
}

const increment = (name: string): Element<Ctx> =>
  leaf<Ctx, Ctx, Ctx>(name, {
    useCase: {
      async execute(input) {
        return Result.ok({ count: input.count + 1, trail: [...input.trail, name] });
      },
    },
    input: (c) => c,
    output: (_c, o) => o,
  });

const failOn = (name: string, atCount: number): Element<Ctx> =>
  leaf<Ctx, Ctx, Ctx>(name, {
    useCase: {
      async execute(input) {
        if (input.count === atCount) {
          return Result.error(new ValidationError({ field: name, value: input.count, message: 'boom' }));
        }
        return Result.ok(input);
      },
    },
    input: (c) => c,
    output: (_c, o) => o,
  });

describe('loop', () => {
  it('runs zero iterations when shouldContinue returns false on the first check', async () => {
    const result = await loop<Ctx>('z', increment('body'), {
      shouldContinue: () => false,
    }).execute({ count: 0, trail: [] });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.ctx.count).toBe(0);
      expect(result.value.trace).toHaveLength(0);
    }
  });

  it('runs the body until shouldStop returns true', async () => {
    const result = await loop<Ctx>('until-three', increment('tick'), {
      shouldStop: (ctx) => ctx.count >= 3,
    }).execute({ count: 0, trail: [] });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.ctx.count).toBe(3);
      expect(result.value.ctx.trail).toEqual(['tick', 'tick', 'tick']);
      expect(result.value.trace.map((e) => e.elementName)).toEqual(['tick', 'tick', 'tick']);
    }
  });

  it('respects shouldContinue iteration budget', async () => {
    const result = await loop<Ctx>('budget', increment('tick'), {
      shouldContinue: (_ctx, i) => i <= 2,
    }).execute({ count: 0, trail: [] });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.ctx.count).toBe(2);
  });

  it('falls back to maxIterations safety cap', async () => {
    const result = await loop<Ctx>('cap', increment('tick'), {
      maxIterations: 5,
    }).execute({ count: 0, trail: [] });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.ctx.count).toBe(5);
  });

  it('threads ctx through composed sequential body', async () => {
    const body = sequential<Ctx>('pair', [increment('a'), increment('b')]);
    const result = await loop<Ctx>('twice', body, {
      shouldStop: (ctx) => ctx.count >= 4,
    }).execute({ count: 0, trail: [] });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.ctx.trail).toEqual(['a', 'b', 'a', 'b']);
      expect(result.value.trace.map((e) => e.elementName)).toEqual(['a', 'b', 'a', 'b']);
    }
  });

  it('propagates body failure and stops the loop', async () => {
    const body = sequential<Ctx>('pair', [increment('a'), failOn('b', 2)]);
    const result = await loop<Ctx>('break-on-fail', body, {
      shouldStop: (ctx) => ctx.count >= 10,
    }).execute({ count: 0, trail: [] });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      // first iteration: a (1), b (no fail). second iteration: a (2), b fails.
      expect(result.error.trace.map((e) => e.elementName)).toEqual(['a', 'b', 'a', 'b']);
      expect(result.error.trace.at(-1)?.status).toBe('failed');
    }
  });

  it('honours an aborted signal before the first iteration', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await loop<Ctx>('aborted', increment('tick'), {
      shouldStop: () => true,
    }).execute({ count: 0, trail: [] }, controller.signal);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.trace.at(-1)?.status).toBe('aborted');
    }
  });
});
