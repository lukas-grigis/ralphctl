import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Result } from 'typescript-result';

import type { ElementResult, KernelError, OnTraceCallback } from '@src/kernel/chain/element.ts';
import { Element } from '@src/kernel/chain/element.ts';
import { Leaf } from '@src/kernel/chain/leaf.ts';
import { Parallel } from '@src/kernel/chain/parallel.ts';
import { Sequential } from '@src/kernel/chain/sequential.ts';

import type { ChainRunnerEvent } from './chain-runner.ts';
import { ChainRunner } from './chain-runner.ts';

interface Ctx {
  readonly value: number;
}

class IncStep extends Element<Ctx> {
  protected override run(ctx: Ctx, _signal?: AbortSignal, onTrace?: OnTraceCallback): Promise<ElementResult<Ctx>> {
    return this.runLeaf(async () => Promise.resolve(Result.ok({ value: ctx.value + 1 })), undefined, onTrace);
  }
}

class FailStep extends Element<Ctx> {
  constructor(
    name: string,
    private readonly err: KernelError = { code: 'boom', message: 'fail' }
  ) {
    super(name);
  }
  protected override run(_ctx: Ctx, _signal?: AbortSignal, onTrace?: OnTraceCallback): Promise<ElementResult<Ctx>> {
    return this.runLeaf(() => Promise.resolve(Result.error(this.err) as Result<Ctx, KernelError>), undefined, onTrace);
  }
}

class WaitStep extends Element<Ctx> {
  constructor(
    name: string,
    private readonly ms: number
  ) {
    super(name);
  }
  protected override run(ctx: Ctx, signal?: AbortSignal, onTrace?: OnTraceCallback): Promise<ElementResult<Ctx>> {
    return this.runLeaf(
      () =>
        new Promise<Result<Ctx, KernelError>>((resolve) => {
          const timer = setTimeout(() => {
            resolve(Result.ok({ value: ctx.value + 1 }));
          }, this.ms);
          if (signal) {
            signal.addEventListener(
              'abort',
              () => {
                clearTimeout(timer);
                resolve(Result.ok({ value: ctx.value + 1 }));
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

describe('ChainRunner', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {
      /* expected for listener-throw tests */
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('successful run: started → step* → completed; status becomes completed; trace populated', async () => {
    const chain = new Sequential<Ctx>('flow', [new IncStep('a'), new IncStep('b'), new IncStep('c')]);
    const runner = new ChainRunner({ id: 'r1', element: chain, initialCtx: { value: 0 } });
    const events: ChainRunnerEvent<Ctx>[] = [];
    runner.subscribe((e) => events.push(e));

    await runner.start();

    expect(runner.status).toBe('completed');
    expect(runner.ctx).toStrictEqual({ value: 3 });
    expect(runner.trace.map((t) => t.stepName)).toStrictEqual(['a', 'b', 'c']);

    const types = events.map((e) => e.type);
    expect(types[0]).toBe('started');
    expect(types[types.length - 1]).toBe('completed');
    const stepNames = events.flatMap((e) => (e.type === 'step' ? [e.entry.stepName] : []));
    expect(stepNames).toStrictEqual(['a', 'b', 'c']);
  });

  it('failed run: status becomes failed and a failed event carries the error', async () => {
    const err: KernelError = { code: 'oops', message: 'no' };
    const chain = new Sequential<Ctx>('flow', [new IncStep('a'), new FailStep('b', err)]);
    const runner = new ChainRunner({ id: 'r2', element: chain, initialCtx: { value: 0 } });
    const events: ChainRunnerEvent<Ctx>[] = [];
    runner.subscribe((e) => events.push(e));

    await runner.start();

    expect(runner.status).toBe('failed');
    const failed = events.find((e) => e.type === 'failed');
    expect(failed).toBeDefined();
    if (failed?.type === 'failed') expect(failed.error).toBe(err);
  });

  it('aborted before start: status flips to aborted and start() does not run the element', async () => {
    const stepFn = vi.fn();
    class SpyStep extends Element<Ctx> {
      protected override run(ctx: Ctx, _signal?: AbortSignal, onTrace?: OnTraceCallback): Promise<ElementResult<Ctx>> {
        return this.runLeaf(
          async () => {
            stepFn();
            return Promise.resolve(Result.ok({ value: ctx.value + 1 }));
          },
          undefined,
          onTrace
        );
      }
    }
    const chain = new Sequential<Ctx>('flow', [new SpyStep('a')]);
    const runner = new ChainRunner({ id: 'r3', element: chain, initialCtx: { value: 0 } });
    const events: ChainRunnerEvent<Ctx>[] = [];
    runner.subscribe((e) => events.push(e));

    runner.abort();
    expect(runner.status).toBe('aborted');

    await runner.start();
    expect(runner.status).toBe('aborted');
    expect(stepFn).not.toHaveBeenCalled();

    expect(events.some((e) => e.type === 'started')).toBe(false);
    expect(events.some((e) => e.type === 'aborted')).toBe(true);
  });

  it('aborted mid-run: status becomes aborted, element observes the abort signal', async () => {
    const chain = new Sequential<Ctx>('flow', [new WaitStep('slow', 200)]);
    const runner = new ChainRunner({ id: 'r4', element: chain, initialCtx: { value: 0 } });
    const startPromise = runner.start();

    // Yield so 'started' is emitted and run is in flight.
    await Promise.resolve();
    runner.abort();
    await startPromise;

    expect(runner.status).toBe('aborted');
  });

  it('start() called twice returns the same promise and does not double-execute', async () => {
    const stepFn = vi.fn();
    class CountStep extends Element<Ctx> {
      protected override run(ctx: Ctx, _signal?: AbortSignal, onTrace?: OnTraceCallback): Promise<ElementResult<Ctx>> {
        return this.runLeaf(
          async () => {
            stepFn();
            return Promise.resolve(Result.ok({ value: ctx.value + 1 }));
          },
          undefined,
          onTrace
        );
      }
    }
    const chain = new Sequential<Ctx>('flow', [new CountStep('a')]);
    const runner = new ChainRunner({ id: 'r5', element: chain, initialCtx: { value: 0 } });

    const p1 = runner.start();
    const p2 = runner.start();
    expect(p1).toBe(p2);
    await p1;

    expect(stepFn).toHaveBeenCalledTimes(1);

    // Calling after terminal returns the same resolved promise.
    const p3 = runner.start();
    expect(p3).toBe(p1);
    await p3;
    expect(stepFn).toHaveBeenCalledTimes(1);
  });

  it('subscribers added after a terminal completed state receive the synthetic terminal event', async () => {
    const chain = new Sequential<Ctx>('flow', [new IncStep('a')]);
    const runner = new ChainRunner({ id: 'r6', element: chain, initialCtx: { value: 0 } });
    await runner.start();

    const events: ChainRunnerEvent<Ctx>[] = [];
    runner.subscribe((e) => events.push(e));

    // Replay should include the step entries followed by the terminal event.
    expect(events.some((e) => e.type === 'step')).toBe(true);
    expect(events[events.length - 1]?.type).toBe('completed');
  });

  it('subscribers added after a terminal failed state receive a synthetic failed event', async () => {
    const err: KernelError = { code: 'oops', message: 'no' };
    const chain = new Sequential<Ctx>('flow', [new FailStep('a', err)]);
    const runner = new ChainRunner({ id: 'r7', element: chain, initialCtx: { value: 0 } });
    await runner.start();

    const events: ChainRunnerEvent<Ctx>[] = [];
    runner.subscribe((e) => events.push(e));
    const failed = events.find((e) => e.type === 'failed');
    expect(failed).toBeDefined();
    if (failed?.type === 'failed') expect(failed.error).toBe(err);
  });

  it('subscribers added after a terminal aborted state receive a synthetic aborted event', async () => {
    const chain = new Sequential<Ctx>('flow', [new IncStep('a')]);
    const runner = new ChainRunner({ id: 'r8', element: chain, initialCtx: { value: 0 } });
    runner.abort();
    await runner.start();

    const events: ChainRunnerEvent<Ctx>[] = [];
    runner.subscribe((e) => events.push(e));
    expect(events).toStrictEqual([{ type: 'aborted' }]);
  });

  it('listener errors do not stall delivery to other listeners', async () => {
    const chain = new Sequential<Ctx>('flow', [new IncStep('a')]);
    const runner = new ChainRunner({ id: 'r9', element: chain, initialCtx: { value: 0 } });

    const seen: string[] = [];
    runner.subscribe(() => {
      seen.push('a');
      throw new Error('boom');
    });
    runner.subscribe((e) => {
      seen.push(`b:${e.type}`);
    });

    await runner.start();
    // The first listener runs each event then throws; the second still sees
    // started, step, completed.
    expect(seen.filter((s) => s.startsWith('b:'))).toStrictEqual(['b:started', 'b:step', 'b:completed']);
  });

  it('exposes ctx, trace, status as read-only views', () => {
    const chain = new Sequential<Ctx>('flow', [new IncStep('a')]);
    const runner = new ChainRunner({ id: 'rA', element: chain, initialCtx: { value: 7 } });

    expect(runner.id).toBe('rA');
    expect(runner.status).toBe('idle');
    expect(runner.ctx).toStrictEqual({ value: 7 });
    expect(runner.trace).toStrictEqual([]);
  });

  it('progressive emission: step events fire as each child completes, before terminal', async () => {
    // Subscribe BEFORE start; record both event order and the live trace
    // length at each step emission. With progressive emission, the trace
    // should grow one entry at a time as the events arrive — not appear
    // all at once just before 'completed'.
    const chain = new Sequential<Ctx>('flow', [new IncStep('a'), new IncStep('b'), new IncStep('c')]);
    const runner = new ChainRunner({ id: 'rB', element: chain, initialCtx: { value: 0 } });

    const stepNamesAtEmission: string[] = [];
    const traceLengthAtEmission: number[] = [];
    let completedAtTraceLength = -1;
    runner.subscribe((e) => {
      if (e.type === 'step') {
        stepNamesAtEmission.push(e.entry.stepName);
        traceLengthAtEmission.push(runner.trace.length);
      } else if (e.type === 'completed') {
        completedAtTraceLength = runner.trace.length;
      }
    });

    await runner.start();

    expect(stepNamesAtEmission).toStrictEqual(['a', 'b', 'c']);
    // Trace grows as events arrive — 1, 2, 3 at the moment each step fires.
    expect(traceLengthAtEmission).toStrictEqual([1, 2, 3]);
    expect(completedAtTraceLength).toBe(3);
  });

  it('progressive emission: parallel children emit step events in completion order', async () => {
    // Three waits with different delays. With progressive emission the
    // step events must arrive in completion order (fastest first), not in
    // start order. The runner subscribes BEFORE start so listener captures
    // every step event live.
    const chain = new Sequential<Ctx>('flow', [
      // Parallel-ish through Sequential is fine for ordering — we have a
      // dedicated parallel test covering the actual Parallel element.
      new WaitStep('first', 5),
      new WaitStep('second', 5),
      new WaitStep('third', 5),
    ]);
    const runner = new ChainRunner({ id: 'rC', element: chain, initialCtx: { value: 0 } });

    const events: ChainRunnerEvent<Ctx>[] = [];
    runner.subscribe((e) => events.push(e));
    await runner.start();

    const stepNames = events.flatMap((e) => (e.type === 'step' ? [e.entry.stepName] : []));
    expect(stepNames).toStrictEqual(['first', 'second', 'third']);
    // 'completed' must come after every step event.
    const completedIdx = events.findIndex((e) => e.type === 'completed');
    const lastStepIdx = events.map((e) => e.type).lastIndexOf('step');
    expect(completedIdx).toBeGreaterThan(lastStepIdx);
  });

  it('progressive emission: failure mid-chain emits completed steps then failed', async () => {
    const err: KernelError = { code: 'oops', message: 'no' };
    const chain = new Sequential<Ctx>('flow', [new IncStep('a'), new IncStep('b'), new FailStep('c', err)]);
    const runner = new ChainRunner({ id: 'rD', element: chain, initialCtx: { value: 0 } });

    const events: ChainRunnerEvent<Ctx>[] = [];
    runner.subscribe((e) => events.push(e));
    await runner.start();

    // Order: started → step(a, completed) → step(b, completed) → step(c, failed) → failed
    const types = events.map((e) => e.type);
    expect(types[0]).toBe('started');
    expect(types[types.length - 1]).toBe('failed');
    const stepEntries = events.flatMap((e) => (e.type === 'step' ? [e.entry] : []));
    expect(stepEntries.map((s) => s.stepName)).toStrictEqual(['a', 'b', 'c']);
    expect(stepEntries.map((s) => s.status)).toStrictEqual(['completed', 'completed', 'failed']);
  });

  it('late subscriber after terminal still receives the synthetic step replay then terminal', async () => {
    // Verify the late-attach replay path remains intact post-refactor.
    const chain = new Sequential<Ctx>('flow', [new IncStep('a'), new IncStep('b')]);
    const runner = new ChainRunner({ id: 'rE', element: chain, initialCtx: { value: 0 } });
    await runner.start();

    const events: ChainRunnerEvent<Ctx>[] = [];
    runner.subscribe((e) => events.push(e));
    const types = events.map((e) => e.type);
    expect(types).toStrictEqual(['step', 'step', 'completed']);
    const stepNames = events.flatMap((e) => (e.type === 'step' ? [e.entry.stepName] : []));
    expect(stepNames).toStrictEqual(['a', 'b']);
  });

  it('regression: nested Sequential→Parallel→bridge-leaf→inner-Sequential failure transitions runner to failed', async () => {
    // Mirrors the executeFlow shape: an outer Sequential whose Parallel
    // step contains a bridge Leaf that runs an inner Sequential. When the
    // inner Sequential fails synchronously (e.g. mark-in-progress on an
    // already-in_progress task before Fix A landed), the runner MUST still
    // settle into 'failed' — otherwise SessionManager dedup keeps the
    // record at 'running' forever and traps the user.
    const innerErr: KernelError = { code: 'invalid-state', message: 'task already in_progress' };
    const innerChain = new Sequential<Ctx>('per-task', [new IncStep('preflight'), new FailStep('mark', innerErr)]);

    const bridge = new Leaf<Ctx, Ctx, Ctx>('task-1', {
      useCase: {
        async execute(input) {
          const innerResult = await innerChain.execute(input);
          if (!innerResult.ok) return Result.error(innerResult.error.error);
          return Result.ok(input);
        },
      },
      input: (ctx) => ctx,
      output: (ctx) => ctx,
    });

    const parallel = new Parallel<Ctx>('execute-tasks', [bridge], {
      concurrency: 4,
      failureMode: 'collect-all',
      reduce: (cs) => cs[cs.length - 1] ?? { value: 0 },
    });

    const outer = new Sequential<Ctx>('execute', [new IncStep('link-skills'), parallel, new IncStep('unlink-skills')]);

    const runner = new ChainRunner({ id: 'rF', element: outer, initialCtx: { value: 0 } });
    const events: ChainRunnerEvent<Ctx>[] = [];
    runner.subscribe((e) => events.push(e));

    await runner.start();

    expect(runner.status).toBe('failed');
    const types = events.map((e) => e.type);
    expect(types[0]).toBe('started');
    expect(types[types.length - 1]).toBe('failed');
    const failed = events.find((e) => e.type === 'failed');
    if (failed?.type === 'failed') expect(failed.error).toBe(innerErr);
  });

  describe('session-context (ALS) wiring', () => {
    it('exposes the runner id via currentSessionId() during element execution', async () => {
      const { currentSessionId } = await import('./session-context.ts');

      let observed: string | undefined;
      class CaptureStep extends Element<Ctx> {
        protected override run(
          ctx: Ctx,
          _signal?: AbortSignal,
          onTrace?: OnTraceCallback
        ): Promise<ElementResult<Ctx>> {
          return this.runLeaf(
            async () => {
              // Sample inside a leaf so we exercise the same code path
              // every business use case will use.
              await Promise.resolve();
              observed = currentSessionId();
              return Result.ok({ value: ctx.value + 1 });
            },
            undefined,
            onTrace
          );
        }
      }

      const runner = new ChainRunner({
        id: 'sess-runner-1',
        element: new CaptureStep('capture'),
        initialCtx: { value: 0 },
      });
      await runner.start();
      expect(observed).toBe('sess-runner-1');
    });

    it('keeps two concurrent runners tagged independently', async () => {
      const { currentSessionId } = await import('./session-context.ts');

      // Each step yields multiple times so the two runs interleave.
      class TaggedStep extends Element<Ctx> {
        constructor(
          name: string,
          private readonly capture: { id?: string }
        ) {
          super(name);
        }
        protected override run(
          ctx: Ctx,
          _signal?: AbortSignal,
          onTrace?: OnTraceCallback
        ): Promise<ElementResult<Ctx>> {
          return this.runLeaf(
            async () => {
              for (let i = 0; i < 3; i++) {
                await Promise.resolve();
              }
              this.capture.id = currentSessionId();
              return Result.ok({ value: ctx.value + 1 });
            },
            undefined,
            onTrace
          );
        }
      }

      const captureA: { id?: string } = {};
      const captureB: { id?: string } = {};
      const runnerA = new ChainRunner({
        id: 'sess-A',
        element: new TaggedStep('a', captureA),
        initialCtx: { value: 0 },
      });
      const runnerB = new ChainRunner({
        id: 'sess-B',
        element: new TaggedStep('b', captureB),
        initialCtx: { value: 0 },
      });
      await Promise.all([runnerA.start(), runnerB.start()]);

      expect(captureA.id).toBe('sess-A');
      expect(captureB.id).toBe('sess-B');
    });
  });
});
