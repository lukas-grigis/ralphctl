import { describe, expect, it, vi } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { ValidationError } from '@src/domain/value/error/validation-error.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';
import { sequential } from '@src/application/chain/build/sequential.ts';
import { type RunnerEvent, createRunner } from '@src/application/chain/run/runner.ts';

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

const failingTag = (name: string): Element<Ctx> =>
  leaf<Ctx, unknown, unknown>(name, {
    useCase: {
      async execute() {
        return Result.error(new ValidationError({ field: name, value: 0, message: 'boom' }));
      },
    },
    input: () => undefined,
    output: (c) => c,
  });

const slowTag = (name: string, ms: number): Element<Ctx> =>
  leaf<Ctx, Ctx, Ctx>(name, {
    useCase: {
      async execute(input, signal) {
        await new Promise<void>((resolve) => {
          if (signal?.aborted) {
            resolve();
            return;
          }
          const t = setTimeout(resolve, ms);
          signal?.addEventListener('abort', () => {
            clearTimeout(t);
            resolve();
          });
        });
        return Result.ok({ trail: [...input.trail, name] });
      },
    },
    input: (c) => c,
    output: (_c, o) => o,
  });

describe('createRunner', () => {
  it('emits started → step* → completed on a successful run', async () => {
    const events: Array<RunnerEvent<Ctx>> = [];
    const runner = createRunner({
      id: 'r1',
      element: sequential<Ctx>('chain', [tag('a'), tag('b')]),
      initialCtx: { trail: [] },
    });
    runner.subscribe((e) => events.push(e));

    await runner.start();

    expect(events.map((e) => e.type)).toEqual(['started', 'step', 'step', 'completed']);
    expect(runner.status).toBe('completed');
    expect(runner.ctx.trail).toEqual(['a', 'b']);
  });

  it('emits started → step* → failed on a failed run', async () => {
    const events: Array<RunnerEvent<Ctx>> = [];
    const runner = createRunner({
      id: 'r2',
      element: sequential<Ctx>('chain', [tag('a'), failingTag('b'), tag('c')]),
      initialCtx: { trail: [] },
    });
    runner.subscribe((e) => events.push(e));

    await runner.start();

    expect(runner.status).toBe('failed');
    const last = events.at(-1);
    expect(last?.type).toBe('failed');
    if (last?.type === 'failed') expect(last.error).toBeInstanceOf(ValidationError);
  });

  it('emits aborted only when abort is called before start', async () => {
    const events: Array<RunnerEvent<Ctx>> = [];
    const runner = createRunner({
      id: 'r3',
      element: tag('a'),
      initialCtx: { trail: [] },
    });
    runner.subscribe((e) => events.push(e));

    runner.abort();
    await runner.start();

    expect(events.map((e) => e.type)).toEqual(['aborted']);
    expect(runner.status).toBe('aborted');
  });

  it('emits started → … → aborted when abort is called during run', async () => {
    const events: Array<RunnerEvent<Ctx>> = [];
    const runner = createRunner({
      id: 'r4',
      element: sequential<Ctx>('chain', [slowTag('a', 50), tag('b')]),
      initialCtx: { trail: [] },
    });
    runner.subscribe((e) => events.push(e));

    const startPromise = runner.start();
    setTimeout(() => runner.abort(), 5);
    await startPromise;

    expect(events[0]?.type).toBe('started');
    expect(events.at(-1)?.type).toBe('aborted');
    expect(runner.status).toBe('aborted');
  });

  it('replays trace + terminal event to a late subscriber after success', async () => {
    const runner = createRunner({
      id: 'r5',
      element: sequential<Ctx>('chain', [tag('a'), tag('b')]),
      initialCtx: { trail: [] },
    });
    await runner.start();

    const events: Array<RunnerEvent<Ctx>> = [];
    runner.subscribe((e) => events.push(e));

    expect(events.map((e) => e.type)).toEqual(['step', 'step', 'completed']);
  });

  it('replays trace + failed event to a late subscriber after failure', async () => {
    const runner = createRunner({
      id: 'r6',
      element: sequential<Ctx>('chain', [tag('a'), failingTag('b')]),
      initialCtx: { trail: [] },
    });
    await runner.start();

    const events: Array<RunnerEvent<Ctx>> = [];
    runner.subscribe((e) => events.push(e));

    expect(events.at(-1)?.type).toBe('failed');
  });

  it('start() is idempotent — second call returns the same promise', async () => {
    const runner = createRunner({
      id: 'r7',
      element: tag('a'),
      initialCtx: { trail: [] },
    });
    const p1 = runner.start();
    const p2 = runner.start();
    expect(p1).toBe(p2);
    await p1;
    const p3 = runner.start();
    await expect(p3).resolves.toBeUndefined();
  });

  it('abort() is idempotent', () => {
    const runner = createRunner({
      id: 'r8',
      element: tag('a'),
      initialCtx: { trail: [] },
    });
    const listener = vi.fn();
    runner.subscribe(listener);
    runner.abort();
    runner.abort();
    runner.abort();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({ type: 'aborted' });
  });

  it('unsubscribe stops further events', async () => {
    const events: Array<RunnerEvent<Ctx>> = [];
    const runner = createRunner({
      id: 'r9',
      element: sequential<Ctx>('chain', [tag('a'), tag('b')]),
      initialCtx: { trail: [] },
    });
    const off = runner.subscribe((e) => events.push(e));
    off();
    await runner.start();
    expect(events).toHaveLength(0);
  });
});
