import { describe, expect, it, vi } from 'vitest';

import { Result } from '@src/domain/result.ts';
import { AbortError } from '@src/domain/value/error/abort-error.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import { RateLimitError } from '@src/domain/value/error/rate-limit-error.ts';
import { ValidationError } from '@src/domain/value/error/validation-error.ts';
import type { Element, ElementResult } from '@src/application/chain/element.ts';
import type { TraceEntry } from '@src/application/chain/trace.ts';
import {
  type BranchOutcome,
  type WaveBranch,
  type WaveScheduleConfig,
  runWaves,
} from '@src/application/chain/run/wave-scheduler.ts';

interface Ctx {
  readonly trail: readonly string[];
}

const BASE: Ctx = { trail: [] };

/** Build a completed trace entry for a fake element. */
const doneEntry = (name: string): TraceEntry => ({ elementName: name, status: 'completed', durationMs: 0 });

/**
 * A leaf-ish element with full instrumentation control: it bumps a shared in-flight gauge on entry,
 * waits for a caller-controlled gate, then settles (ok or with a supplied error) and decrements the
 * gauge. Honours the runner's abort signal so a kill tears it down promptly + runs `onCleanup`.
 */
interface FakeElementOpts {
  readonly name: string;
  readonly gauge: { count: number; max: number };
  readonly settle: Promise<void>;
  readonly error?: () => DomainError;
  readonly onCleanup?: () => void;
}

const fakeElement = (opts: FakeElementOpts): Element<Ctx> => ({
  name: opts.name,
  async execute(ctx, signal, onTrace): Promise<ElementResult<Ctx>> {
    opts.gauge.count += 1;
    opts.gauge.max = Math.max(opts.gauge.max, opts.gauge.count);
    try {
      await Promise.race([
        opts.settle,
        new Promise<void>((resolve) => {
          if (signal?.aborted) {
            resolve();
            return;
          }
          signal?.addEventListener('abort', () => resolve(), { once: true });
        }),
      ]);
    } finally {
      opts.gauge.count -= 1;
    }

    if (signal?.aborted) {
      opts.onCleanup?.();
      const error = new AbortError({ elementName: opts.name });
      const entry: TraceEntry = { elementName: opts.name, status: 'aborted', durationMs: 0, error };
      onTrace?.(entry);
      return Result.error({ error, trace: [entry] });
    }
    if (opts.error) {
      const error = opts.error();
      const entry: TraceEntry = { elementName: opts.name, status: 'failed', durationMs: 0, error };
      onTrace?.(entry);
      return Result.error({ error, trace: [entry] });
    }
    const entry = doneEntry(opts.name);
    onTrace?.(entry);
    return Result.ok({ ctx: { trail: [...ctx.trail, opts.name] }, trace: [entry] });
  },
});

/** Immediately-completing element — for synchronous-ish ordering / sequential-degrade tests. */
const okElement = (name: string): Element<Ctx> => ({
  name,
  async execute(ctx, _signal, onTrace): Promise<ElementResult<Ctx>> {
    const entry = doneEntry(name);
    onTrace?.(entry);
    return Result.ok({ ctx: { trail: [...ctx.trail, name] }, trace: [entry] });
  },
});

/** A deferred handle so a test can release a branch's gate at a precise moment. */
const deferred = (): { promise: Promise<void>; resolve: () => void } => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

/** Default config: pass-through merge that records nothing extra; concat each outcome's trail. */
const mergeConcat: WaveScheduleConfig<Ctx>['merge'] = (base, outcomes) => ({
  trail: [...base.trail, ...outcomes.flatMap((o) => o.ctx.trail.filter((t) => !base.trail.includes(t)))],
});

const cfg = (over: Partial<WaveScheduleConfig<Ctx>> = {}): WaveScheduleConfig<Ctx> => ({
  maxConcurrency: 5,
  merge: mergeConcat,
  ...over,
});

describe('runWaves — pool bound', () => {
  it('never exceeds maxConcurrency in flight across a 30-branch wave', async () => {
    const gauge = { count: 0, max: 0 };
    // Each branch resolves on a microtask tick; the gauge records the high-water mark.
    const branches: Array<WaveBranch<Ctx>> = Array.from({ length: 30 }, (_, i) => ({
      id: `t${String(i)}`,
      element: fakeElement({ name: `b${String(i)}`, gauge, settle: Promise.resolve() }),
    }));

    const result = await runWaves([branches], BASE, cfg({ maxConcurrency: 5 }));

    expect(result.ok).toBe(true);
    expect(gauge.max).toBeLessThanOrEqual(5);
    expect(gauge.max).toBeGreaterThan(0);
  });

  it('re-clamps maxConcurrency above 5 down to 5', async () => {
    const gauge = { count: 0, max: 0 };
    const gate = deferred();
    const branches: Array<WaveBranch<Ctx>> = Array.from({ length: 12 }, (_, i) => ({
      id: `t${String(i)}`,
      element: fakeElement({ name: `b${String(i)}`, gauge, settle: gate.promise }),
    }));

    const run = runWaves([branches], BASE, cfg({ maxConcurrency: 99 }));
    // Let the pool prime before the gate opens.
    await Promise.resolve();
    await Promise.resolve();
    expect(gauge.max).toBeLessThanOrEqual(5);
    gate.resolve();
    const result = await run;
    expect(result.ok).toBe(true);
  });
});

describe('runWaves — strictly sequential waves', () => {
  it('does not start wave k+1 before wave k fully settles and merges', async () => {
    const order: string[] = [];
    const gaugeA = { count: 0, max: 0 };
    const gaugeB = { count: 0, max: 0 };
    const gateA = deferred();

    const waveA: Array<WaveBranch<Ctx>> = [{ id: 'a', element: fakeElementTracked('a', gaugeA, gateA.promise, order) }];
    const waveB: Array<WaveBranch<Ctx>> = [
      { id: 'b', element: fakeElementTracked('b', gaugeB, Promise.resolve(), order) },
    ];

    const config = cfg({
      merge: (base, outcomes) => {
        order.push('merge');
        return mergeConcat(base, outcomes);
      },
    });

    const run = runWaves([waveA, waveB], BASE, config);
    await Promise.resolve();
    await Promise.resolve();
    // Wave B must not have started, and merge must not have run, while A is still gated.
    expect(order).toEqual(['enter:a']);

    gateA.resolve();
    const result = await run;
    expect(result.ok).toBe(true);
    // Wave A fully settled (enter+exit) AND merge ran before wave B entered; B then settles + merges.
    expect(order).toEqual(['enter:a', 'exit:a', 'merge', 'enter:b', 'exit:b', 'merge']);
  });
});

/** Like `fakeElement` but records enter/exit markers + a merge marker is pushed by the test. */
const fakeElementTracked = (
  name: string,
  gauge: { count: number; max: number },
  settle: Promise<void>,
  order: string[]
): Element<Ctx> => ({
  name,
  async execute(ctx): Promise<ElementResult<Ctx>> {
    gauge.count += 1;
    order.push(`enter:${name}`);
    await settle;
    gauge.count -= 1;
    order.push(`exit:${name}`);
    return Result.ok({ ctx: { trail: [...ctx.trail, name] }, trace: [doneEntry(name)] });
  },
});

describe('runWaves — deterministic trace', () => {
  it('assembles the combined trace in branch-declaration order, not completion order', async () => {
    const gauge = { count: 0, max: 0 };
    // b0 settles LAST, b2 settles FIRST — completion order is the reverse of declaration order.
    const gates = [deferred(), deferred(), deferred()];
    const branches: Array<WaveBranch<Ctx>> = [0, 1, 2].map((i) => ({
      id: `t${String(i)}`,
      element: fakeElement({ name: `b${String(i)}`, gauge, settle: gates[i]!.promise }),
    }));

    const run = runWaves([branches], BASE, cfg());
    await Promise.resolve();
    gates[2]!.resolve();
    await Promise.resolve();
    gates[1]!.resolve();
    await Promise.resolve();
    gates[0]!.resolve();
    const result = await run;

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Declaration order b0, b1, b2 — independent of the b2→b1→b0 completion order.
    expect(result.value.trace.map((e) => e.elementName)).toEqual(['b0', 'b1', 'b2']);
  });
});

describe('runWaves — non-fatal absorption', () => {
  it('absorbs a non-fatal branch failure and lets siblings continue', async () => {
    const gauge = { count: 0, max: 0 };
    const branches: Array<WaveBranch<Ctx>> = [
      { id: 'ok1', element: fakeElement({ name: 'ok1', gauge, settle: Promise.resolve() }) },
      {
        id: 'bad',
        element: fakeElement({
          name: 'bad',
          gauge,
          settle: Promise.resolve(),
          error: () => new ValidationError({ field: 'x', value: 0, message: 'boom' }),
        }),
      },
      { id: 'ok2', element: fakeElement({ name: 'ok2', gauge, settle: Promise.resolve() }) },
    ];

    const captured: Array<BranchOutcome<Ctx>> = [];
    const config = cfg({
      merge: (base, outcomes) => {
        captured.push(...outcomes);
        return mergeConcat(base, outcomes);
      },
    });

    const result = await runWaves([branches], BASE, config);

    expect(result.ok).toBe(true);
    expect(captured.map((o) => `${o.id}:${o.status}`)).toEqual(['ok1:completed', 'bad:failed', 'ok2:completed']);
    expect(captured.find((o) => o.id === 'bad')?.error).toBeInstanceOf(ValidationError);
  });
});

describe('runWaves — abort wins with bounded settle + cleanup', () => {
  it('forwards an outer abort, settles in-flight branches with a bounded wait, runs their cleanup, returns AbortError verbatim', async () => {
    const gauge = { count: 0, max: 0 };
    const cleanups: string[] = [];
    // These branches never resolve on their own — only an abort can settle them. If the abort were
    // NOT forwarded, `runWaves` would hang forever; the test's own timeout would catch that. We
    // additionally assert the settle is prompt (resolves on the next macrotask, no real wait).
    const branches: Array<WaveBranch<Ctx>> = [0, 1].map((i) => ({
      id: `t${String(i)}`,
      element: fakeElement({
        name: `b${String(i)}`,
        gauge,
        settle: new Promise<void>(() => {}),
        onCleanup: () => cleanups.push(`b${String(i)}`),
      }),
    }));

    const ac = new AbortController();
    const run = runWaves([branches], BASE, cfg(), ac.signal);

    // Let the pool prime, then abort.
    await Promise.resolve();
    await Promise.resolve();
    expect(gauge.count).toBe(2);
    ac.abort();

    // Bounded settle: the whole run resolves before this 100ms guard, proving the abort propagated
    // and we did not block on the never-resolving `settle` promise.
    const settledInTime = await Promise.race([
      run.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 100)),
    ]);
    expect(settledInTime).toBe(true);

    const result = await run;
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // AbortError returned verbatim (NOT folded into a per-branch outcome).
    expect(result.error.error).toBeInstanceOf(AbortError);
    // Every in-flight branch settled (gauge drained) and its cleanup actually ran.
    expect(gauge.count).toBe(0);
    expect(cleanups.sort()).toEqual(['b0', 'b1']);
  });

  it('never launches a branch when the outer signal is already aborted', async () => {
    const gauge = { count: 0, max: 0 };
    const ac = new AbortController();
    ac.abort();
    const branches: Array<WaveBranch<Ctx>> = [
      { id: 'a', element: fakeElement({ name: 'a', gauge, settle: Promise.resolve() }) },
    ];

    const result = await runWaves([branches], BASE, cfg(), ac.signal);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error).toBeInstanceOf(AbortError);
    expect(gauge.max).toBe(0);
  });
});

describe('runWaves — rate-limit fatal', () => {
  it("'drain' (default) lets in-flight siblings finish, then stops launching the rest of the wave", async () => {
    const gauge = { count: 0, max: 0 };
    const siblingGate = deferred();
    const siblingFinished = vi.fn();

    // Wave of 4, cap 2: t0 hits rate-limit immediately; t1 is in flight and must finish; t2/t3
    // must never launch.
    const launched: string[] = [];
    const mk = (id: string, error?: () => DomainError, gate?: Promise<void>): WaveBranch<Ctx> => ({
      id,
      element: {
        name: id,
        async execute(ctx, signal): Promise<ElementResult<Ctx>> {
          launched.push(id);
          gauge.count += 1;
          await (gate ?? Promise.resolve());
          gauge.count -= 1;
          if (signal?.aborted) {
            const e = new AbortError({ elementName: id });
            return Result.error({ error: e, trace: [{ elementName: id, status: 'aborted', durationMs: 0, error: e }] });
          }
          if (error) {
            const e = error();
            return Result.error({ error: e, trace: [{ elementName: id, status: 'failed', durationMs: 0, error: e }] });
          }
          if (id === 't1') siblingFinished();
          return Result.ok({ ctx, trace: [doneEntry(id)] });
        },
      },
    });

    const branches = [
      mk('t0', () => new RateLimitError({ subCode: 'spawn-exit' })),
      mk('t1', undefined, siblingGate.promise),
      mk('t2'),
      mk('t3'),
    ];

    const run = runWaves([branches], BASE, cfg({ maxConcurrency: 2, onFatal: 'drain' }));
    await Promise.resolve();
    await Promise.resolve();
    // The in-flight sibling t1 has not finished yet (gated); release it now.
    siblingGate.resolve();
    const result = await run;

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error).toBeInstanceOf(RateLimitError);
    // t1 finished cleanly (drained), t2/t3 never launched.
    expect(siblingFinished).toHaveBeenCalledTimes(1);
    expect(launched.sort()).toEqual(['t0', 't1']);
  });

  it("'kill' aborts in-flight siblings immediately on a rate-limit", async () => {
    const gauge = { count: 0, max: 0 };
    const cleanups: string[] = [];
    const branches: Array<WaveBranch<Ctx>> = [
      {
        id: 't0',
        element: fakeElement({
          name: 't0',
          gauge,
          settle: Promise.resolve(),
          error: () => new RateLimitError({ subCode: 'spawn-exit' }),
        }),
      },
      {
        id: 't1',
        element: fakeElement({
          name: 't1',
          gauge,
          settle: new Promise<void>(() => {}),
          onCleanup: () => cleanups.push('t1'),
        }),
      },
    ];

    const result = await runWaves([branches], BASE, cfg({ maxConcurrency: 2, onFatal: 'kill' }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error).toBeInstanceOf(RateLimitError);
    expect(gauge.count).toBe(0);
    expect(cleanups).toEqual(['t1']);
  });
});

describe('runWaves — maxConcurrency === 1 degrades to fully sequential', () => {
  it('runs branches one at a time in declaration order', async () => {
    const gauge = { count: 0, max: 0 };
    const branches: Array<WaveBranch<Ctx>> = ['a', 'b', 'c', 'd'].map((id) => ({
      id,
      element: fakeElement({ name: id, gauge, settle: Promise.resolve() }),
    }));

    const result = await runWaves([branches], BASE, cfg({ maxConcurrency: 1 }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(gauge.max).toBe(1);
    expect(result.value.trace.map((e) => e.elementName)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('treats a single multi-branch wave with cap 1 identically to N singleton waves', async () => {
    const branches: Array<WaveBranch<Ctx>> = ['a', 'b'].map((id) => ({ id, element: okElement(id) }));
    const wide = await runWaves([branches], BASE, cfg({ maxConcurrency: 1 }));
    const singletons = await runWaves([[branches[0]!], [branches[1]!]], BASE, cfg({ maxConcurrency: 1 }));

    expect(wide.ok && singletons.ok).toBe(true);
    if (!wide.ok || !singletons.ok) return;
    expect(wide.value.trace.map((e) => e.elementName)).toEqual(singletons.value.trace.map((e) => e.elementName));
  });
});

describe('runWaves — onBranchRunner hook', () => {
  it('invokes onBranchRunner once per branch with the branch and a runner whose id matches', async () => {
    const seen: Array<{ id: string; runnerId: string }> = [];
    const branches: Array<WaveBranch<Ctx>> = ['a', 'b'].map((id) => ({ id, element: okElement(id) }));

    await runWaves(
      [branches],
      BASE,
      cfg({ onBranchRunner: (runner, branch) => seen.push({ id: branch.id, runnerId: runner.id }) })
    );

    expect(seen).toEqual([
      { id: 'a', runnerId: 'a' },
      { id: 'b', runnerId: 'b' },
    ]);
  });
});
