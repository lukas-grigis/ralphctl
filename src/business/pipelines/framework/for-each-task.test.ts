import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StepContext } from '@src/domain/context.ts';
import { DomainError, ParseError, SpawnError, StepError } from '@src/domain/errors.ts';
import type { DomainResult } from '@src/domain/types.ts';
import { Result } from '@src/domain/types.ts';
import type { RateLimitCoordinatorPort } from '@src/business/ports/rate-limit-coordinator.ts';
import type { HarnessEvent, SignalBusPort, Unsubscribe } from '@src/business/ports/signal-bus.ts';
import { executePipeline } from './pipeline.ts';
import { pipeline, step } from './helpers.ts';
import type { ParallelSharedServices } from './types.ts';
import type { ForEachTaskContext, RetryAction, SchedulerStats } from './for-each-task.ts';
import { forEachTask } from './for-each-task.ts';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

interface TestItem {
  id: string;
  repo: string;
}

function makeCtx(): ForEachTaskContext {
  return { sprintId: 'test-sprint' };
}

function unwrap<T>(result: DomainResult<T>): T {
  expect(result.ok).toBe(true);
  return result.value as T;
}

function unwrapErr<T>(result: DomainResult<T>): DomainError {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('unreachable');
  return result.error;
}

/** Controllable fake coordinator for rate-limit tests. */
class FakeCoordinator implements RateLimitCoordinatorPort {
  public pauseCalls: number[] = [];
  public disposed = false;
  public readonly remainingMs = 0;
  private paused = false;
  private resolvers: (() => void)[] = [];

  get isPaused(): boolean {
    return this.paused;
  }
  pause(delayMs: number): void {
    this.paused = true;
    this.pauseCalls.push(delayMs);
  }
  async waitIfPaused(): Promise<void> {
    if (!this.paused) return;
    await new Promise<void>((resolve) => {
      this.resolvers.push(resolve);
    });
  }
  /** Test-only: unblock all waiters and mark as resumed. */
  resume(): void {
    this.paused = false;
    const rs = this.resolvers;
    this.resolvers = [];
    for (const r of rs) r();
  }
  dispose(): void {
    this.disposed = true;
    this.resume();
  }
}

class FakeBus implements SignalBusPort {
  public events: HarnessEvent[] = [];
  public disposed = false;
  emit(event: HarnessEvent): void {
    this.events.push(event);
  }
  subscribe(): Unsubscribe {
    return () => {
      /* noop */
    };
  }
  dispose(): void {
    this.disposed = true;
  }
}

function makeTestServices(): { services: ParallelSharedServices; coord: FakeCoordinator; bus: FakeBus } {
  const coord = new FakeCoordinator();
  const bus = new FakeBus();
  return { services: { coordinator: coord, signalBus: bus }, coord, bus };
}

/** Walk a DomainError's cause chain to find a SpawnError (errors get wrapped in StepError). */
function findSpawnError(err: DomainError): SpawnError | null {
  let current: Error | undefined = err;
  while (current) {
    if (current instanceof SpawnError) return current;
    current = current instanceof DomainError ? current.cause : undefined;
  }
  return null;
}

/** Inner pipeline that reads the injected item from ctx[itemKey] and runs `work`. */
function innerPipelineFor(
  name: string,
  work: (
    item: TestItem
  ) => Promise<Result<Partial<StepContext>, DomainError>> | Result<Partial<StepContext>, DomainError>,
  itemKey = 'task'
) {
  return pipeline<StepContext>(name, [
    step<StepContext>('work', async (ctx) => {
      const item = (ctx as unknown as Record<string, TestItem | undefined>)[itemKey];
      if (!item) throw new Error(`inner pipeline did not receive ctx.${itemKey}`);
      return await work(item);
    }),
  ]);
}

// A tiny sleep that yields the event loop — used sparingly where timing
// overlap must be observed.
const tick = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Happy paths
// ---------------------------------------------------------------------------

describe('forEachTask - happy paths', () => {
  it('runs items sequentially when concurrency is 1', async () => {
    const items: TestItem[] = [
      { id: '1', repo: 'a' },
      { id: '2', repo: 'b' },
      { id: '3', repo: 'c' },
    ];
    const pending = new Set(items.map((i) => i.id));
    const settled: string[] = [];

    const s = forEachTask<TestItem>({
      steps: innerPipelineFor('inner', async (item) => {
        await tick(10);
        settled.push(item.id);
        pending.delete(item.id);
        return Result.ok({});
      }),
      strategy: {
        concurrency: 1,
        pullItems: () => items.filter((i) => pending.has(i.id)),
        mutexKey: (i) => i.repo,
      },
      policies: {
        retryPolicy: () => ({ action: 'fail', drainInFlight: false }),
      },
    });

    const p = pipeline<ForEachTaskContext>('outer', [s]);
    const result = await executePipeline(p, makeCtx());
    const { context } = unwrap(result);

    expect(settled).toEqual(['1', '2', '3']);
    expect(context.schedulerStats?.completed).toBe(3);
    expect(context.schedulerStats?.failed).toBe(0);
    expect(context.schedulerStats?.inFlight).toBe(0);
  });

  it('runs items concurrently when concurrency > 1', async () => {
    const items: TestItem[] = [
      { id: '1', repo: 'a' },
      { id: '2', repo: 'b' },
      { id: '3', repo: 'c' },
      { id: '4', repo: 'd' },
    ];
    const pending = new Set(items.map((i) => i.id));
    let inFlightNow = 0;
    let maxInFlight = 0;

    const s = forEachTask<TestItem>({
      steps: innerPipelineFor('inner', async (item) => {
        inFlightNow++;
        maxInFlight = Math.max(maxInFlight, inFlightNow);
        await tick(20);
        inFlightNow--;
        pending.delete(item.id);
        return Result.ok({});
      }),
      strategy: {
        concurrency: 3,
        pullItems: () => items.filter((i) => pending.has(i.id)),
        mutexKey: (i) => i.repo,
      },
      policies: {
        retryPolicy: () => ({ action: 'fail', drainInFlight: false }),
      },
    });

    const p = pipeline<ForEachTaskContext>('outer', [s]);
    const result = await executePipeline(p, makeCtx());
    const { context } = unwrap(result);

    expect(maxInFlight).toBe(3);
    expect(context.schedulerStats?.completed).toBe(4);
  });

  it('concurrency: auto caps at min(uniqueKeys, maxConcurrency)', async () => {
    // 5 unique keys, maxConcurrency 2 → expect 2 at a time.
    const items: TestItem[] = Array.from({ length: 5 }, (_, i) => ({
      id: String(i),
      repo: `repo-${String(i)}`,
    }));
    const pending = new Set(items.map((i) => i.id));
    let inFlightNow = 0;
    let maxInFlight = 0;

    const s = forEachTask<TestItem>({
      steps: innerPipelineFor('inner', async (item) => {
        inFlightNow++;
        maxInFlight = Math.max(maxInFlight, inFlightNow);
        await tick(20);
        inFlightNow--;
        pending.delete(item.id);
        return Result.ok({});
      }),
      strategy: {
        concurrency: 'auto',
        maxConcurrency: 2,
        pullItems: () => items.filter((i) => pending.has(i.id)),
        mutexKey: (i) => i.repo,
      },
      policies: {
        retryPolicy: () => ({ action: 'fail', drainInFlight: false }),
      },
    });

    const p = pipeline<ForEachTaskContext>('outer', [s]);
    await executePipeline(p, makeCtx());
    expect(maxInFlight).toBe(2);
  });

  it('inner pipeline receives ctx[itemKey]', async () => {
    const items: TestItem[] = [{ id: 'x', repo: 'r' }];
    const pending = new Set(items.map((i) => i.id));
    let seenId: string | null = null;

    const s = forEachTask<TestItem>({
      steps: pipeline<StepContext>('inner', [
        step<StepContext>('read-item', (ctx) => {
          const item = (ctx as unknown as Record<string, TestItem>)['myKey'];
          if (!item) throw new Error('item not injected');
          seenId = item.id;
          pending.delete(item.id);
          return Result.ok({});
        }),
      ]),
      itemKey: 'myKey',
      strategy: {
        concurrency: 1,
        pullItems: () => items.filter((i) => pending.has(i.id)),
        mutexKey: (i) => i.repo,
      },
      policies: {
        retryPolicy: () => ({ action: 'fail', drainInFlight: false }),
      },
    });

    await executePipeline(pipeline<ForEachTaskContext>('outer', [s]), makeCtx());
    expect(seenId).toBe('x');
  });
});

// ---------------------------------------------------------------------------
// Mutex key enforcement
// ---------------------------------------------------------------------------

describe('forEachTask - mutex key enforcement', () => {
  it('two items with the same key never overlap', async () => {
    const items: TestItem[] = [
      { id: '1', repo: 'shared' },
      { id: '2', repo: 'shared' },
    ];
    const pending = new Set(items.map((i) => i.id));
    const events: string[] = [];

    const s = forEachTask<TestItem>({
      steps: innerPipelineFor('inner', async (item) => {
        events.push(`start:${item.id}`);
        await tick(20);
        events.push(`end:${item.id}`);
        pending.delete(item.id);
        return Result.ok({});
      }),
      strategy: {
        concurrency: 5,
        pullItems: () => items.filter((i) => pending.has(i.id)),
        mutexKey: (i) => i.repo,
      },
      policies: {
        retryPolicy: () => ({ action: 'fail', drainInFlight: false }),
      },
    });

    await executePipeline(pipeline<ForEachTaskContext>('outer', [s]), makeCtx());

    // Expected: start:1 end:1 start:2 end:2 — the second should not start
    // before the first ends, because they share a mutex key.
    const idx = (s: string) => events.indexOf(s);
    expect(idx('end:1')).toBeLessThan(idx('start:2'));
  });

  it('items with different keys overlap when concurrency permits', async () => {
    const items: TestItem[] = [
      { id: '1', repo: 'a' },
      { id: '2', repo: 'b' },
    ];
    const pending = new Set(items.map((i) => i.id));
    let bothInFlight = false;
    let inFlightNow = 0;

    const s = forEachTask<TestItem>({
      steps: innerPipelineFor('inner', async (item) => {
        inFlightNow++;
        if (inFlightNow === 2) bothInFlight = true;
        await tick(15);
        inFlightNow--;
        pending.delete(item.id);
        return Result.ok({});
      }),
      strategy: {
        concurrency: 2,
        pullItems: () => items.filter((i) => pending.has(i.id)),
        mutexKey: (i) => i.repo,
      },
      policies: {
        retryPolicy: () => ({ action: 'fail', drainInFlight: false }),
      },
    });

    await executePipeline(pipeline<ForEachTaskContext>('outer', [s]), makeCtx());
    expect(bothInFlight).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Rate-limit pause / resume
// ---------------------------------------------------------------------------

describe('forEachTask - rate-limit pause/resume', () => {
  it('pauses the coordinator on pause-all and resumes on unpause', async () => {
    const items: TestItem[] = [
      { id: '1', repo: 'a' },
      { id: '2', repo: 'b' },
    ];
    // Simulate "pull returns items that have not yet run"
    const pending = new Set(items.map((i) => i.id));
    const completed = new Set<string>();
    const { services, coord } = makeTestServices();

    let attempts1 = 0;
    let pauseCalls = 0;
    let resumeCalls = 0;

    const s = forEachTask<TestItem>({
      steps: innerPipelineFor('inner', (item) => {
        if (item.id === '1') {
          attempts1++;
          if (attempts1 === 1) {
            // First attempt on item 1 fails with rate limit.
            return Result.error(new SpawnError('rate limited', '429', 1, null));
          }
        }
        completed.add(item.id);
        pending.delete(item.id);
        return Result.ok({});
      }),
      strategy: {
        concurrency: 2,
        pullItems: () => items.filter((i) => pending.has(i.id) && !completed.has(i.id)),
        mutexKey: (i) => i.repo,
      },
      policies: {
        retryPolicy: (_item, err) => {
          // Inner errors come wrapped in StepError by executePipeline — walk
          // the cause chain to find the originating spawn error.
          const spawn = findSpawnError(err);
          if (spawn?.rateLimited) {
            return { action: 'pause-all', delayMs: 100, requeueItem: true } satisfies RetryAction;
          }
          return { action: 'fail', drainInFlight: false };
        },
        onPause: () => {
          pauseCalls++;
          // Auto-resume after a short time so the test completes.
          setTimeout(() => {
            coord.resume();
          }, 20);
        },
        onResume: () => {
          resumeCalls++;
        },
      },
      createServices: () => services,
    });

    const result = await executePipeline(pipeline<ForEachTaskContext>('outer', [s]), makeCtx());
    const { context } = unwrap(result);

    expect(pauseCalls).toBe(1);
    expect(resumeCalls).toBe(1);
    expect(coord.pauseCalls).toEqual([100]);
    expect(context.schedulerStats?.completed).toBe(2);
    expect(context.schedulerStats?.requeued).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Requeue / retry-now / skip-repo
// ---------------------------------------------------------------------------

describe('forEachTask - retry policies', () => {
  it('requeue picks the item up on the next pull tick', async () => {
    let attempts = 0;
    const items: TestItem[] = [{ id: '1', repo: 'a' }];
    const pending = new Set(['1']);

    const s = forEachTask<TestItem>({
      steps: innerPipelineFor('inner', () => {
        attempts++;
        if (attempts === 1) {
          return Result.error(new ParseError('transient'));
        }
        pending.delete('1');
        return Result.ok({});
      }),
      strategy: {
        concurrency: 1,
        pullItems: () => (pending.has('1') ? items : []),
        mutexKey: (i) => i.repo,
      },
      policies: {
        retryPolicy: (_item, _err, attempt) =>
          attempt === 1 ? { action: 'requeue' } : { action: 'fail', drainInFlight: false },
      },
    });

    const result = await executePipeline(pipeline<ForEachTaskContext>('outer', [s]), makeCtx());
    const { context } = unwrap(result);

    expect(attempts).toBe(2);
    expect(context.schedulerStats?.completed).toBe(1);
    expect(context.schedulerStats?.requeued).toBe(1);
  });

  it('retry-now relaunches same item without consulting pullItems', async () => {
    let attempts = 0;
    let pullCalls = 0;
    const item: TestItem = { id: '1', repo: 'a' };

    const s = forEachTask<TestItem>({
      steps: innerPipelineFor('inner', () => {
        attempts++;
        if (attempts < 3) return Result.error(new ParseError('try-again'));
        return Result.ok({});
      }),
      strategy: {
        concurrency: 1,
        pullItems: () => {
          pullCalls++;
          return pullCalls === 1 ? [item] : [];
        },
        mutexKey: (i) => i.repo,
      },
      policies: {
        retryPolicy: (_item, _err, attempt) =>
          attempt < 3 ? { action: 'retry-now' } : { action: 'fail', drainInFlight: false },
      },
    });

    const result = await executePipeline(pipeline<ForEachTaskContext>('outer', [s]), makeCtx());
    const { context } = unwrap(result);

    expect(attempts).toBe(3);
    expect(context.schedulerStats?.completed).toBe(1);
    // retry-now does not increment `requeued`.
    expect(context.schedulerStats?.requeued).toBe(0);
  });

  it('skip-repo blocks further items with the same mutex key', async () => {
    const items: TestItem[] = [
      { id: '1', repo: 'a' }, // fails -> skip repo 'a'
      { id: '2', repo: 'a' }, // should be filtered out
      { id: '3', repo: 'b' }, // unrelated, runs fine
    ];
    const pending = new Set(items.map((i) => i.id));
    const ran: string[] = [];

    const s = forEachTask<TestItem>({
      steps: innerPipelineFor('inner', (item) => {
        ran.push(item.id);
        pending.delete(item.id);
        if (item.id === '1') return Result.error(new ParseError('boom'));
        return Result.ok({});
      }),
      strategy: {
        concurrency: 1,
        pullItems: () => items.filter((i) => pending.has(i.id)),
        mutexKey: (i) => i.repo,
      },
      policies: {
        retryPolicy: (item) => ({ action: 'skip-repo', key: item.repo }),
      },
    });

    const result = await executePipeline(pipeline<ForEachTaskContext>('outer', [s]), makeCtx());
    const { context } = unwrap(result);

    expect(ran).toEqual(['1', '3']);
    expect(context.schedulerStats?.completed).toBe(1);
    expect(context.schedulerStats?.failed).toBe(1);
    expect(context.schedulerStats?.pausedRepos.has('a')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Fail with drain
// ---------------------------------------------------------------------------

describe('forEachTask - fail action', () => {
  it('fail with drainInFlight: true waits for in-flight to settle', async () => {
    const items: TestItem[] = [
      { id: '1', repo: 'a' }, // fails with action: fail
      { id: '2', repo: 'b' }, // still runs (concurrency 2) and settles
    ];
    let pull = [...items];
    let item2Settled = false;

    const s = forEachTask<TestItem>({
      steps: innerPipelineFor('inner', async (item) => {
        if (item.id === '1') {
          // Fail immediately
          return Result.error(new ParseError('kaboom'));
        }
        // Item 2 — takes longer than item 1's failure.
        await tick(30);
        item2Settled = true;
        return Result.ok({});
      }),
      strategy: {
        concurrency: 2,
        pullItems: () => {
          const copy = [...pull];
          pull = [];
          return copy;
        },
        mutexKey: (i) => i.repo,
      },
      policies: {
        retryPolicy: () => ({ action: 'fail', drainInFlight: true }),
      },
    });

    const result = await executePipeline(pipeline<ForEachTaskContext>('outer', [s]), makeCtx());
    const err = unwrapErr(result);
    expect(err).toBeInstanceOf(StepError);
    expect(err.message).toContain('kaboom');
    expect(item2Settled).toBe(true);
  });

  it('fail with drainInFlight: false returns immediately', async () => {
    const items: TestItem[] = [
      { id: '1', repo: 'a' },
      { id: '2', repo: 'b' },
    ];
    let pull = [...items];
    let item2Settled = false;
    let item2Started = false;

    const s = forEachTask<TestItem>({
      steps: innerPipelineFor('inner', async (item) => {
        if (item.id === '1') {
          return Result.error(new ParseError('kaboom'));
        }
        item2Started = true;
        await tick(30);
        item2Settled = true;
        return Result.ok({});
      }),
      strategy: {
        concurrency: 2,
        pullItems: () => {
          const copy = [...pull];
          pull = [];
          return copy;
        },
        mutexKey: (i) => i.repo,
      },
      policies: {
        retryPolicy: () => ({ action: 'fail', drainInFlight: false }),
      },
    });

    const result = await executePipeline(pipeline<ForEachTaskContext>('outer', [s]), makeCtx());
    expect(result.ok).toBe(false);
    // With drain: false, the scheduler returns before item 2 finishes.
    expect(item2Started).toBe(true);
    expect(item2Settled).toBe(false);
    // Let item 2 finish so it doesn't leak into other tests.
    await tick(50);
  });

  it('returned error carries the original failing error', async () => {
    const item: TestItem = { id: '1', repo: 'a' };
    let pull: TestItem[] = [item];
    const original = new ParseError('specific-message');

    const s = forEachTask<TestItem>({
      steps: innerPipelineFor('inner', () => Result.error(original)),
      strategy: {
        concurrency: 1,
        pullItems: () => {
          const copy = [...pull];
          pull = [];
          return copy;
        },
        mutexKey: (i) => i.repo,
      },
      policies: {
        retryPolicy: () => ({ action: 'fail', drainInFlight: false }),
      },
    });

    const result = await executePipeline(pipeline<ForEachTaskContext>('outer', [s]), makeCtx());
    const err = unwrapErr(result);
    // The outer executePipeline wraps into a StepError, but the inner
    // cause chain should surface our original message.
    expect(err.message).toContain('specific-message');
  });
});

// ---------------------------------------------------------------------------
// between hook
// ---------------------------------------------------------------------------

describe('forEachTask - between hook', () => {
  it('calls between after every success except the final one', async () => {
    const items: TestItem[] = [
      { id: '1', repo: 'a' },
      { id: '2', repo: 'b' },
      { id: '3', repo: 'c' },
    ];
    const pending = new Set(items.map((i) => i.id));
    const betweenCalls: SchedulerStats[] = [];

    const s = forEachTask<TestItem>({
      steps: innerPipelineFor('inner', (item) => {
        pending.delete(item.id);
        return Result.ok({});
      }),
      strategy: {
        concurrency: 1,
        pullItems: () => items.filter((i) => pending.has(i.id)),
        mutexKey: (i) => i.repo,
      },
      policies: {
        retryPolicy: () => ({ action: 'fail', drainInFlight: false }),
        between: (stats) => {
          betweenCalls.push({ ...stats, pausedRepos: new Set(stats.pausedRepos) });
          return 'continue';
        },
      },
    });

    const result = await executePipeline(pipeline<ForEachTaskContext>('outer', [s]), makeCtx());
    const { context } = unwrap(result);
    expect(context.schedulerStats?.completed).toBe(3);
    // Between should fire after #1 and #2 completions, not after #3.
    expect(betweenCalls).toHaveLength(2);
    expect(betweenCalls[0]?.completed).toBe(1);
    expect(betweenCalls[1]?.completed).toBe(2);
  });

  it("returning 'stop' breaks the loop before remaining items launch", async () => {
    const items: TestItem[] = [
      { id: '1', repo: 'a' },
      { id: '2', repo: 'b' },
      { id: '3', repo: 'c' },
    ];
    const pending = new Set(items.map((i) => i.id));
    const ran: string[] = [];

    const s = forEachTask<TestItem>({
      steps: innerPipelineFor('inner', (item) => {
        ran.push(item.id);
        pending.delete(item.id);
        return Result.ok({});
      }),
      strategy: {
        concurrency: 1,
        pullItems: () => items.filter((i) => pending.has(i.id)),
        mutexKey: (i) => i.repo,
      },
      policies: {
        retryPolicy: () => ({ action: 'fail', drainInFlight: false }),
        between: (stats) => (stats.completed === 1 ? 'stop' : 'continue'),
      },
    });

    const result = await executePipeline(pipeline<ForEachTaskContext>('outer', [s]), makeCtx());
    const { context } = unwrap(result);
    expect(ran).toEqual(['1']);
    expect(context.schedulerStats?.completed).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// stopWhen
// ---------------------------------------------------------------------------

describe('forEachTask - stopWhen', () => {
  it('terminates the loop once stopWhen returns true', async () => {
    const items: TestItem[] = Array.from({ length: 10 }, (_, i) => ({ id: String(i), repo: String(i) }));
    const pending = new Set(items.map((i) => i.id));

    const s = forEachTask<TestItem>({
      steps: innerPipelineFor('inner', (item) => {
        pending.delete(item.id);
        return Result.ok({});
      }),
      strategy: {
        concurrency: 1,
        pullItems: () => items.filter((i) => pending.has(i.id)),
        mutexKey: (i) => i.repo,
        stopWhen: (stats) => stats.completed >= 2,
      },
      policies: {
        retryPolicy: () => ({ action: 'fail', drainInFlight: false }),
      },
    });

    const result = await executePipeline(pipeline<ForEachTaskContext>('outer', [s]), makeCtx());
    const { context } = unwrap(result);
    expect(context.schedulerStats?.completed).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Services lifecycle
// ---------------------------------------------------------------------------

describe('forEachTask - services lifecycle', () => {
  it('calls createServices once and disposeServices in finally on success', async () => {
    let created = 0;
    let disposed = 0;
    const { services } = makeTestServices();

    const s = forEachTask<TestItem>({
      steps: innerPipelineFor('inner', () => Result.ok({})),
      strategy: {
        concurrency: 1,
        pullItems: () => [{ id: '1', repo: 'a' }],
        mutexKey: (i) => i.repo,
        stopWhen: (stats) => stats.completed >= 1,
      },
      policies: { retryPolicy: () => ({ action: 'fail', drainInFlight: false }) },
      createServices: () => {
        created++;
        return services;
      },
      disposeServices: () => {
        disposed++;
      },
    });

    await executePipeline(pipeline<ForEachTaskContext>('outer', [s]), makeCtx());
    expect(created).toBe(1);
    expect(disposed).toBe(1);
  });

  it('calls disposeServices even when fail action fires', async () => {
    let disposed = 0;
    const { services } = makeTestServices();

    const s = forEachTask<TestItem>({
      steps: innerPipelineFor('inner', () => Result.error(new ParseError('x'))),
      strategy: {
        concurrency: 1,
        pullItems: () => [{ id: '1', repo: 'a' }],
        mutexKey: (i) => i.repo,
      },
      policies: { retryPolicy: () => ({ action: 'fail', drainInFlight: false }) },
      createServices: () => services,
      disposeServices: () => {
        disposed++;
      },
    });

    await executePipeline(pipeline<ForEachTaskContext>('outer', [s]), makeCtx());
    expect(disposed).toBe(1);
  });

  it('calls disposeServices even when inner pipeline throws', async () => {
    let disposed = 0;
    const { services } = makeTestServices();

    const s = forEachTask<TestItem>({
      steps: pipeline<StepContext>('inner', [
        // eslint-disable-next-line @typescript-eslint/require-await -- need async to throw
        step<StepContext>('boom', async () => {
          throw new Error('unexpected');
        }),
      ]),
      strategy: {
        concurrency: 1,
        pullItems: () => [{ id: '1', repo: 'a' }],
        mutexKey: (i) => i.repo,
      },
      policies: { retryPolicy: () => ({ action: 'fail', drainInFlight: false }) },
      createServices: () => services,
      disposeServices: () => {
        disposed++;
      },
    });

    await executePipeline(pipeline<ForEachTaskContext>('outer', [s]), makeCtx());
    expect(disposed).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Pull dynamics
// ---------------------------------------------------------------------------

describe('forEachTask - pull dynamics', () => {
  it('picks up items that appear after the initial pull', async () => {
    const pool: TestItem[] = [{ id: '1', repo: 'a' }];
    const pending = new Set(pool.map((i) => i.id));

    const s = forEachTask<TestItem>({
      steps: innerPipelineFor('inner', (item) => {
        pending.delete(item.id);
        // When item 1 finishes, item 2 appears in the pool.
        if (item.id === '1' && !pool.some((p) => p.id === '2')) {
          pool.push({ id: '2', repo: 'b' });
          pending.add('2');
        }
        return Result.ok({});
      }),
      strategy: {
        concurrency: 1,
        pullItems: () => pool.filter((i) => pending.has(i.id)),
        mutexKey: (i) => i.repo,
      },
      policies: { retryPolicy: () => ({ action: 'fail', drainInFlight: false }) },
    });

    const result = await executePipeline(pipeline<ForEachTaskContext>('outer', [s]), makeCtx());
    const { context } = unwrap(result);
    expect(context.schedulerStats?.completed).toBe(2);
  });

  it('pullItems is called multiple times (not once upfront)', async () => {
    let pullCalls = 0;
    const item: TestItem = { id: '1', repo: 'a' };
    let delivered = false;

    const s = forEachTask<TestItem>({
      steps: innerPipelineFor('inner', () => Result.ok({})),
      strategy: {
        concurrency: 1,
        pullItems: () => {
          pullCalls++;
          if (!delivered) {
            delivered = true;
            return [item];
          }
          return [];
        },
        mutexKey: (i) => i.repo,
      },
      policies: { retryPolicy: () => ({ action: 'fail', drainInFlight: false }) },
    });

    await executePipeline(pipeline<ForEachTaskContext>('outer', [s]), makeCtx());
    expect(pullCalls).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// Lifecycle callbacks
// ---------------------------------------------------------------------------

describe('forEachTask - cooperative cancellation', () => {
  it('already-aborted signal stops the scheduler before any item launches', async () => {
    const items: TestItem[] = [
      { id: '1', repo: 'a' },
      { id: '2', repo: 'b' },
    ];
    const pending = new Set(items.map((i) => i.id));
    const ran: string[] = [];

    const ac = new AbortController();
    ac.abort();

    const s = forEachTask<TestItem>({
      steps: innerPipelineFor('inner', (item) => {
        ran.push(item.id);
        pending.delete(item.id);
        return Result.ok({});
      }),
      strategy: {
        concurrency: 2,
        pullItems: () => items.filter((i) => pending.has(i.id)),
        mutexKey: (i) => i.repo,
      },
      policies: {
        retryPolicy: () => ({ action: 'fail', drainInFlight: false }),
      },
    });

    const ctx: ForEachTaskContext = { sprintId: 'test-sprint', abortSignal: ac.signal };
    const result = await executePipeline(pipeline<ForEachTaskContext>('outer', [s]), ctx);
    const { context } = unwrap(result);

    expect(ran).toEqual([]);
    expect(context.schedulerStats?.cancelled).toBe(true);
    expect(context.schedulerStats?.completed).toBe(0);
  });

  it('abort during a tick stops further launches without aborting in-flight work', async () => {
    const items: TestItem[] = [
      { id: '1', repo: 'a' },
      { id: '2', repo: 'b' },
      { id: '3', repo: 'c' },
    ];
    const pending = new Set(items.map((i) => i.id));
    const ran: string[] = [];
    const ac = new AbortController();

    const s = forEachTask<TestItem>({
      steps: innerPipelineFor('inner', async (item) => {
        ran.push(item.id);
        // Abort as soon as the first item starts — subsequent launches must stop.
        if (item.id === '1') ac.abort();
        await tick(10);
        pending.delete(item.id);
        return Result.ok({});
      }),
      strategy: {
        concurrency: 1,
        pullItems: () => items.filter((i) => pending.has(i.id)),
        mutexKey: (i) => i.repo,
      },
      policies: {
        retryPolicy: () => ({ action: 'fail', drainInFlight: false }),
      },
    });

    const ctx: ForEachTaskContext = { sprintId: 'test-sprint', abortSignal: ac.signal };
    const result = await executePipeline(pipeline<ForEachTaskContext>('outer', [s]), ctx);
    const { context } = unwrap(result);

    // Only the first item ran — items 2 and 3 never launched because the
    // scheduler's next tick observed `abortSignal.aborted`.
    expect(ran).toEqual(['1']);
    expect(context.schedulerStats?.cancelled).toBe(true);
    expect(context.schedulerStats?.completed).toBe(1);
  });

  it('passes abortSignal into createServices', async () => {
    const ac = new AbortController();
    let observed: AbortSignal | undefined;

    const s = forEachTask<TestItem>({
      steps: innerPipelineFor('inner', () => Result.ok({})),
      strategy: {
        concurrency: 1,
        pullItems: () => [],
        mutexKey: (i) => i.repo,
      },
      policies: { retryPolicy: () => ({ action: 'fail', drainInFlight: false }) },
      createServices: ({ abortSignal }) => {
        observed = abortSignal;
        return makeTestServices().services;
      },
    });

    const ctx: ForEachTaskContext = { sprintId: 'test-sprint', abortSignal: ac.signal };
    await executePipeline(pipeline<ForEachTaskContext>('outer', [s]), ctx);
    expect(observed).toBe(ac.signal);
  });
});

describe('forEachTask - onLaunch / onSettle callbacks', () => {
  it('fires onLaunch before each launch and onSettle after each settlement', async () => {
    const items: TestItem[] = [
      { id: '1', repo: 'a' },
      { id: '2', repo: 'b' },
    ];
    const pending = new Set(items.map((i) => i.id));
    const launches: string[] = [];
    const settlements: [string, string][] = [];

    const s = forEachTask<TestItem>({
      steps: innerPipelineFor('inner', (item) => {
        pending.delete(item.id);
        return item.id === '2' ? Result.error(new ParseError('x')) : Result.ok({});
      }),
      strategy: {
        concurrency: 1,
        pullItems: () => items.filter((i) => pending.has(i.id)),
        mutexKey: (i) => i.repo,
      },
      policies: {
        retryPolicy: () => ({ action: 'skip-repo', key: 'b' }),
        onLaunch: (i) => launches.push(i.id),
        onSettle: (i, result) => settlements.push([i.id, result]),
      },
    });

    await executePipeline(pipeline<ForEachTaskContext>('outer', [s]), makeCtx());
    expect(launches).toEqual(['1', '2']);
    expect(settlements).toEqual([
      ['1', 'success'],
      ['2', 'failed'],
    ]);
  });
});
