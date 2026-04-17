import { describe, it, expect } from 'vitest';
import { Result } from '@src/domain/types.ts';
import type { DomainResult } from '@src/domain/types.ts';
import { StepError, ParseError, SpawnError } from '@src/domain/errors.ts';
import type { StepContext } from '@src/domain/context.ts';
import type { RateLimitCoordinatorPort } from '@src/business/ports/rate-limit-coordinator.ts';
import type { HarnessEvent, SignalBusPort, Unsubscribe } from '@src/business/ports/signal-bus.ts';
import { executePipeline } from './pipeline.ts';
import { step, pipeline, nested, parallelMap, insertBefore, insertAfter, replace, renameStep } from './helpers.ts';
import type { ParallelSharedServices, ParallelStepResult } from './types.ts';

interface TestContext extends StepContext {
  counter?: number;
  label?: string;
  trace?: string[];
  parallelResults?: ParallelStepResult[];
}

function makeCtx(overrides: Partial<TestContext> = {}): TestContext {
  return { sprintId: 'test-sprint', ...overrides };
}

function unwrap<T>(result: DomainResult<T>): T {
  expect(result.ok).toBe(true);
  return result.value as T;
}

function unwrapErr<T>(result: DomainResult<T>): StepError {
  expect(result.ok).toBe(false);
  return result.error as StepError;
}

// ---------------------------------------------------------------------------
// nested
// ---------------------------------------------------------------------------

describe('nested', () => {
  it('propagates inner pipeline context to outer', async () => {
    const inner = pipeline<TestContext>('inner', [
      step<TestContext>('set-counter', () => Result.ok({ counter: 7 })),
      step<TestContext>('set-label', () => Result.ok({ label: 'from-inner' })),
    ]);
    const outer = pipeline<TestContext>('outer', [
      step<TestContext>('before', () => Result.ok({ counter: 1 })),
      nested<TestContext>('run-inner', inner),
      step<TestContext>('after', (c) => Result.ok({ label: `${c.label ?? ''}-plus` })),
    ]);

    const result = await executePipeline(outer, makeCtx());
    const { context } = unwrap(result);
    expect(context.counter).toBe(7);
    expect(context.label).toBe('from-inner-plus');
  });

  it('wraps inner failure as StepError with prefixed step path', async () => {
    const inner = pipeline<TestContext>('inner-pipeline', [
      step<TestContext>('ok', () => Result.ok({ counter: 1 })),
      step<TestContext>('fail', () => Result.error(new ParseError('bad data'))),
    ]);
    const outer = pipeline<TestContext>('outer', [nested<TestContext>('run-inner', inner)]);

    const result = await executePipeline(outer, makeCtx());
    const error = unwrapErr(result);
    expect(error).toBeInstanceOf(StepError);
    // The outer executePipeline wraps with "Step 'run-inner' failed: ..."
    // and our nested helper contributes "[run-inner > fail] bad data"
    expect(error.message).toContain('run-inner > fail');
    expect(error.message).toContain('bad data');
  });

  it('propagates unknown thrown errors from inner as StepError', async () => {
    const inner = pipeline<TestContext>('inner', [
      // eslint-disable-next-line @typescript-eslint/require-await -- need async to throw
      step<TestContext>('boom', async () => {
        throw new Error('unexpected');
      }),
    ]);
    const outer = pipeline<TestContext>('outer', [nested<TestContext>('wrapper', inner)]);
    const result = await executePipeline(outer, makeCtx());
    const error = unwrapErr(result);
    expect(error.message).toContain('wrapper');
    expect(error.message).toContain('unexpected');
  });
});

// ---------------------------------------------------------------------------
// parallelMap
// ---------------------------------------------------------------------------

function makeTestServices(): ParallelSharedServices {
  const events: HarnessEvent[] = [];
  const coordinator: RateLimitCoordinatorPort = {
    isPaused: false,
    remainingMs: 0,
    pause: () => {
      /* noop */
    },
    waitIfPaused: async () => {
      /* noop */
    },
    dispose: () => {
      /* noop */
    },
  };
  const signalBus: SignalBusPort = {
    emit: (event) => events.push(event),
    subscribe: (): Unsubscribe => () => {
      /* noop */
    },
    dispose: () => {
      /* noop */
    },
  };
  return { coordinator, signalBus };
}

describe('parallelMap', () => {
  it('runs items concurrently', async () => {
    const DELAY_MS = 50;
    const started: number[] = [];
    const finished: number[] = [];

    const p = pipeline<TestContext>('p', [
      parallelMap<number, TestContext>(
        'fanout',
        () => [1, 2, 3, 4],
        (item) =>
          pipeline<TestContext>(`inner-${String(item)}`, [
            step<TestContext>('work', async () => {
              started.push(Date.now());
              await new Promise((r) => setTimeout(r, DELAY_MS));
              finished.push(Date.now());
              return Result.ok({});
            }),
          ])
      ),
    ]);

    const t0 = Date.now();
    const result = await executePipeline(p, makeCtx());
    const elapsed = Date.now() - t0;
    const { context } = unwrap(result);

    expect(context.parallelResults).toHaveLength(4);
    // If truly parallel, total elapsed should be close to DELAY_MS, not 4*DELAY_MS
    expect(elapsed).toBeLessThan(DELAY_MS * 3);
  });

  it('respects concurrencyLimit', async () => {
    const DELAY_MS = 40;
    let inFlight = 0;
    let maxInFlight = 0;

    const p = pipeline<TestContext>('p', [
      parallelMap<number, TestContext>(
        'fanout',
        () => [1, 2, 3, 4, 5, 6],
        (item) =>
          pipeline<TestContext>(`inner-${String(item)}`, [
            step<TestContext>('work', async () => {
              inFlight++;
              maxInFlight = Math.max(maxInFlight, inFlight);
              await new Promise((r) => setTimeout(r, DELAY_MS));
              inFlight--;
              return Result.ok({});
            }),
          ]),
        { concurrencyLimit: 2 }
      ),
    ]);

    await executePipeline(p, makeCtx());
    expect(maxInFlight).toBe(2);
  });

  it('aborts pending on failFast: true', async () => {
    const DELAY_MS = 30;
    let executed = 0;

    const p = pipeline<TestContext>('p', [
      parallelMap<number, TestContext>(
        'fanout',
        () => [1, 2, 3, 4, 5, 6, 7, 8],
        (item) =>
          pipeline<TestContext>(`inner-${String(item)}`, [
            step<TestContext>('work', async () => {
              executed++;
              await new Promise((r) => setTimeout(r, DELAY_MS));
              if (item === 2) {
                return Result.error(new ParseError('fail on item 2'));
              }
              return Result.ok({});
            }),
          ]),
        { concurrencyLimit: 2, failFast: true }
      ),
    ]);

    const result = await executePipeline(p, makeCtx());
    // failFast surfaces the error through the outer pipeline
    expect(result.ok).toBe(false);
    // Not all items should have been executed — concurrency 2 means after the
    // failing settlement, remaining items are skipped.
    expect(executed).toBeLessThan(8);
  });

  it('aggregates errors when failFast: false', async () => {
    const p = pipeline<TestContext>('p', [
      parallelMap<number, TestContext>(
        'fanout',
        () => [1, 2, 3, 4],
        (item) =>
          pipeline<TestContext>(`inner-${String(item)}`, [
            step<TestContext>('work', () => {
              if (item % 2 === 0) return Result.error(new ParseError(`fail-${String(item)}`));
              return Result.ok({});
            }),
          ]),
        { failFast: false }
      ),
    ]);

    const result = await executePipeline(p, makeCtx());
    const { context } = unwrap(result);
    expect(context.parallelResults).toHaveLength(4);
    const errors = context.parallelResults?.filter((r) => r.error) ?? [];
    const successes = context.parallelResults?.filter((r) => !r.error) ?? [];
    expect(errors).toHaveLength(2);
    expect(successes).toHaveLength(2);
  });

  it('marks rate-limit errors with isRateLimited', async () => {
    const p = pipeline<TestContext>('p', [
      parallelMap<number, TestContext>(
        'fanout',
        () => [1, 2],
        (item) =>
          pipeline<TestContext>(`inner-${String(item)}`, [
            step<TestContext>('work', () => {
              if (item === 1) {
                return Result.error(new SpawnError('overloaded', 'rate limit 429', 1, null));
              }
              return Result.ok({});
            }),
          ]),
        { failFast: true } // rate limits should NOT trigger failFast
      ),
    ]);

    const result = await executePipeline(p, makeCtx());
    const { context } = unwrap(result);
    expect(context.parallelResults).toHaveLength(2);
    const rateLimited = context.parallelResults?.filter((r) => r.isRateLimited) ?? [];
    expect(rateLimited).toHaveLength(1);
  });

  it('calls disposeServices even on inner failure', async () => {
    let disposed = 0;
    const services = makeTestServices();

    const p = pipeline<TestContext>('p', [
      parallelMap<number, TestContext>(
        'fanout',
        () => [1, 2],
        (item) =>
          pipeline<TestContext>(`inner-${String(item)}`, [
            step<TestContext>('work', () => Result.error(new ParseError(`fail-${String(item)}`))),
          ]),
        {
          createServices: () => services,
          disposeServices: () => {
            disposed++;
          },
          failFast: false,
        }
      ),
    ]);

    await executePipeline(p, makeCtx());
    expect(disposed).toBe(1);
  });

  it('calls disposeServices even when inner throws', async () => {
    let disposed = 0;

    const p = pipeline<TestContext>('p', [
      parallelMap<number, TestContext>(
        'fanout',
        () => [1, 2],
        (item) =>
          pipeline<TestContext>(`inner-${String(item)}`, [
            // eslint-disable-next-line @typescript-eslint/require-await -- need async to throw
            step<TestContext>('work', async () => {
              throw new Error(`kaboom-${String(item)}`);
            }),
          ]),
        {
          disposeServices: () => {
            disposed++;
          },
          failFast: false,
        }
      ),
    ]);

    await executePipeline(p, makeCtx());
    expect(disposed).toBe(1);
  });

  it('empty items list completes immediately with empty parallelResults', async () => {
    const p = pipeline<TestContext>('p', [
      parallelMap<number, TestContext>(
        'fanout',
        () => [],
        () => pipeline<TestContext>('never', [])
      ),
    ]);
    const result = await executePipeline(p, makeCtx());
    const { context } = unwrap(result);
    expect(context.parallelResults).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// insertBefore / insertAfter / replace
// ---------------------------------------------------------------------------

describe('insertBefore', () => {
  it('inserts the new step before the target', () => {
    const a = step<TestContext>('a', () => Result.ok({}));
    const b = step<TestContext>('b', () => Result.ok({}));
    const c = step<TestContext>('c', () => Result.ok({}));
    const p = pipeline<TestContext>('p', [a, b, c]);
    const injected = step<TestContext>('injected', () => Result.ok({}));

    const modified = insertBefore(p, 'b', injected);
    expect(modified.steps.map((s) => s.name)).toEqual(['a', 'injected', 'b', 'c']);
  });

  it('throws when target step does not exist', () => {
    const p = pipeline<TestContext>('p', [step<TestContext>('a', () => Result.ok({}))]);
    const injected = step<TestContext>('x', () => Result.ok({}));
    expect(() => insertBefore(p, 'missing', injected)).toThrow(/not found/);
  });

  it('returns a new definition without mutating the input', () => {
    const p = pipeline<TestContext>('p', [
      step<TestContext>('a', () => Result.ok({})),
      step<TestContext>('b', () => Result.ok({})),
    ]);
    const injected = step<TestContext>('x', () => Result.ok({}));
    const modified = insertBefore(p, 'b', injected);
    expect(p.steps.map((s) => s.name)).toEqual(['a', 'b']);
    expect(modified).not.toBe(p);
  });
});

describe('insertAfter', () => {
  it('inserts the new step after the target', () => {
    const a = step<TestContext>('a', () => Result.ok({}));
    const b = step<TestContext>('b', () => Result.ok({}));
    const c = step<TestContext>('c', () => Result.ok({}));
    const p = pipeline<TestContext>('p', [a, b, c]);
    const injected = step<TestContext>('injected', () => Result.ok({}));

    const modified = insertAfter(p, 'b', injected);
    expect(modified.steps.map((s) => s.name)).toEqual(['a', 'b', 'injected', 'c']);
  });

  it('appends at the end when target is last', () => {
    const a = step<TestContext>('a', () => Result.ok({}));
    const p = pipeline<TestContext>('p', [a]);
    const injected = step<TestContext>('injected', () => Result.ok({}));
    const modified = insertAfter(p, 'a', injected);
    expect(modified.steps.map((s) => s.name)).toEqual(['a', 'injected']);
  });

  it('throws when target step does not exist', () => {
    const p = pipeline<TestContext>('p', [step<TestContext>('a', () => Result.ok({}))]);
    expect(() =>
      insertAfter(
        p,
        'missing',
        step<TestContext>('x', () => Result.ok({}))
      )
    ).toThrow(/not found/);
  });
});

describe('replace', () => {
  it('replaces the target step', () => {
    const a = step<TestContext>('a', () => Result.ok({}));
    const b = step<TestContext>('b', () => Result.ok({}));
    const c = step<TestContext>('c', () => Result.ok({}));
    const p = pipeline<TestContext>('p', [a, b, c]);
    const repl = step<TestContext>('new-b', () => Result.ok({}));

    const modified = replace(p, 'b', repl);
    expect(modified.steps.map((s) => s.name)).toEqual(['a', 'new-b', 'c']);
  });

  it('throws when target step does not exist', () => {
    const p = pipeline<TestContext>('p', [step<TestContext>('a', () => Result.ok({}))]);
    expect(() =>
      replace(
        p,
        'missing',
        step<TestContext>('x', () => Result.ok({}))
      )
    ).toThrow(/not found/);
  });
});

// ---------------------------------------------------------------------------
// renameStep
// ---------------------------------------------------------------------------

describe('renameStep', () => {
  it('renames the step without altering execute or hooks', async () => {
    const original = step<TestContext>('generic-name', () => Result.ok({ counter: 42 }), {
      pre: (ctx) => Result.ok({ ...ctx, label: 'pre-ran' }),
    });
    const renamed = renameStep('specific-name', original);

    expect(renamed.name).toBe('specific-name');
    expect(renamed.execute).toBe(original.execute);
    expect(renamed.hooks).toBe(original.hooks);

    // Confirm the renamed step runs exactly the same way in a pipeline.
    const p = pipeline<TestContext>('p', [renamed]);
    const result = await executePipeline(p, makeCtx());
    const { context, stepResults } = unwrap(result);
    expect(stepResults.map((r) => r.stepName)).toEqual(['specific-name']);
    expect(context.counter).toBe(42);
    expect(context.label).toBe('pre-ran');
  });
});
