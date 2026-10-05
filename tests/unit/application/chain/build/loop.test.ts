import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { ValidationError } from '@src/domain/value/error/validation-error.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';
import { loop } from '@src/application/chain/build/loop.ts';
import { sequential } from '@src/application/chain/build/sequential.ts';
import type { StepStart, TraceEntry } from '@src/application/chain/trace.ts';

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

  it('stamps the iteration on forwarded and returned entries alike', async () => {
    const forwarded: TraceEntry[] = [];
    const result = await loop<Ctx>('round', increment('tick'), {
      shouldStop: (ctx) => ctx.count >= 2,
    }).execute({ count: 0, trail: [] }, undefined, (e) => forwarded.push(e));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.trace.map((e) => e.iterations)).toEqual([
        [{ loop: 'round', n: 1 }],
        [{ loop: 'round', n: 2 }],
      ]);
      expect(result.value.trace).toEqual(forwarded);
    }
  });

  it('stamps a failing iteration on the returned error trace too', async () => {
    const forwarded: TraceEntry[] = [];
    const body = sequential<Ctx>('pair', [increment('a'), failOn('b', 2)]);
    const result = await loop<Ctx>('round', body, { shouldStop: () => false }).execute(
      { count: 0, trail: [] },
      undefined,
      (e) => forwarded.push(e)
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.trace.map((e) => [e.elementName, e.iterations?.[0]?.n])).toEqual([
        ['a', 1],
        ['b', 1],
        ['a', 2],
        ['b', 2],
      ]);
      expect(result.error.trace).toEqual(forwarded);
    }
  });

  it('orders nested loop stamps outer-first', async () => {
    const forwarded: TraceEntry[] = [];
    const inner = loop<Ctx>('inner', increment('tick'), { shouldContinue: (_c, i) => i <= 2 });
    const outer = loop<Ctx>('outer', inner, { shouldContinue: (_c, i) => i <= 2 });

    const result = await outer.execute({ count: 0, trail: [] }, undefined, (e) => forwarded.push(e));

    const expected = [
      [
        { loop: 'outer', n: 1 },
        { loop: 'inner', n: 1 },
      ],
      [
        { loop: 'outer', n: 1 },
        { loop: 'inner', n: 2 },
      ],
      [
        { loop: 'outer', n: 2 },
        { loop: 'inner', n: 1 },
      ],
      [
        { loop: 'outer', n: 2 },
        { loop: 'inner', n: 2 },
      ],
    ];
    expect(forwarded.map((e) => e.iterations)).toEqual(expected);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.trace.map((e) => e.iterations)).toEqual(expected);
  });

  it("leaves the loop's own aborted entry unstamped", async () => {
    const controller = new AbortController();
    const forwarded: TraceEntry[] = [];
    // Aborting in shouldStop lets the body finish cleanly, so the loop's own pre-iteration check trips next.
    const el = loop<Ctx>('round', increment('tick'), {
      shouldStop: () => {
        controller.abort();
        return false;
      },
    });

    const result = await el.execute({ count: 0, trail: [] }, controller.signal, (e) => forwarded.push(e));

    expect(result.ok).toBe(false);
    expect(forwarded.map((e) => [e.elementName, e.status])).toEqual([
      ['tick', 'completed'],
      ['round', 'aborted'],
    ]);
    const last = forwarded.at(-1);
    expect(last && 'iterations' in last).toBe(false);
  });

  it('leaves entries outside any loop unstamped', async () => {
    const result = await sequential<Ctx>('flat', [increment('a')]).execute({ count: 0, trail: [] });
    expect(result.ok).toBe(true);
    if (result.ok) expect('iterations' in result.value.trace[0]!).toBe(false);
  });

  it('stamps step starts with the enclosing iterations', async () => {
    const starts: StepStart[] = [];
    await loop<Ctx>('round', increment('tick'), { shouldStop: (ctx) => ctx.count >= 2 }).execute(
      { count: 0, trail: [] },
      undefined,
      undefined,
      (s) => starts.push(s)
    );
    expect(starts).toEqual([
      { elementName: 'tick', iterations: [{ loop: 'round', n: 1 }] },
      { elementName: 'tick', iterations: [{ loop: 'round', n: 2 }] },
    ]);
  });

  it('exposes maxIterations only when passed explicitly, plus label and internal', () => {
    const plain = loop<Ctx>('plain', increment('tick'));
    expect(plain.kind).toBe('loop');
    expect('maxIterations' in plain).toBe(false);
    expect('label' in plain).toBe(false);
    expect('display' in plain).toBe(false);

    const capped = loop<Ctx>('capped', increment('tick'), { maxIterations: 5, label: 'Round', internal: true });
    expect(capped.maxIterations).toBe(5);
    expect(capped.label).toBe('Round');
    expect(capped.display).toEqual({ internal: true });
  });

  it('shows a display-only cap without bounding execution', async () => {
    const shown = loop<Ctx>('shown', increment('tick'), {
      displayMaxIterations: 2,
      shouldContinue: (_ctx, i) => i <= 4,
    });
    expect(shown.maxIterations).toBe(2);
    const result = await shown.execute({ count: 0, trail: [] });
    expect(result.ok && result.value.ctx.count).toBe(4);

    const explicit = loop<Ctx>('explicit', increment('tick'), { maxIterations: 3, displayMaxIterations: 9 });
    expect(explicit.maxIterations).toBe(3);
  });
});
