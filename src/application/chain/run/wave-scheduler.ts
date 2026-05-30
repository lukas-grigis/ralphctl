import { Result } from '@src/domain/result.ts';
import { AbortError } from '@src/domain/value/error/abort-error.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import { isRecoverableTurnError } from '@src/business/task/turn-error-policy.ts';

import type { Element, ElementFailure } from '@src/application/chain/element.ts';
import type { Trace } from '@src/application/chain/trace.ts';
import { type Runner, createRunner } from '@src/application/chain/run/runner.ts';

/**
 * Hard ceiling on in-flight branches, regardless of what the caller passes. Mirrors the
 * `settings.concurrency.maxParallelTasks` clamp (`[1,5]`) — the parallel cap. Re-clamped
 * here so a mis-wired caller can never blow past the budget the rest of the harness was sized
 * against.
 */
const MAX_CONCURRENCY_CEILING = 5;

const clampConcurrency = (n: number): number => {
  if (!Number.isFinite(n)) return 1;
  return Math.min(MAX_CONCURRENCY_CEILING, Math.max(1, Math.trunc(n)));
};

/**
 * One unit of parallel work inside a wave. The caller supplies a stable `id` (used both as the
 * branch's `runWithSession` scope and as the `chainId = task-<id>` the EventBus bridge keys on)
 * plus the `element` to run on that branch's own {@link Runner}.
 *
 * @public
 */
export interface WaveBranch<TCtx> {
  /** Stable identifier — the branch's session-scope id and the bus bridge's `chainId`. */
  readonly id: string;
  /** The chain to execute for this branch, on its own runner / abort controller / trace ring. */
  readonly element: Element<TCtx>;
}

/**
 * The settled result of one {@link WaveBranch}. The caller's `merge` reducer folds an array of
 * these (in branch-declaration order) back into the carried ctx between waves.
 *
 *  - `status === 'completed'` → `ctx` is the branch's final ctx; `error` is absent.
 *  - `status === 'failed'`    → a NON-fatal branch error was absorbed; `ctx` is the branch's
 *                               last ctx (its `initialCtx` if it never advanced), `error` carries
 *                               the absorbed `DomainError` so the reducer can record the block.
 *
 * Fatal errors (`aborted` / `rate-limit`) never surface as a `BranchOutcome` — they short-circuit
 * the whole wave (see {@link runWaves}).
 *
 * @public
 */
export interface BranchOutcome<TCtx> {
  readonly id: string;
  readonly status: 'completed' | 'failed';
  readonly ctx: TCtx;
  readonly error?: DomainError;
}

/**
 * Configuration for {@link runWaves}. Everything ctx-specific is injected so the scheduler stays
 * generic — it imports nothing from any flow.
 *
 * @public
 */
export interface WaveScheduleConfig<TCtx> {
  /** Desired max in-flight branches per wave. Re-clamped to `[1,5]` internally. */
  readonly maxConcurrency: number;
  /**
   * Fan-in reducer. Given the ctx carried into the wave and the wave's settled branch outcomes
   * (in branch-declaration order), produce the ctx carried into the NEXT wave. Pure; the caller
   * supplies the flow-specific merge semantics (e.g. the implement task-overlay reducer).
   */
  readonly merge: (base: TCtx, outcomes: ReadonlyArray<BranchOutcome<TCtx>>) => TCtx;
  /**
   * Blast radius of an exhausted-retry `rate-limit` in one branch.
   *  - `'drain'` (default): let the already-in-flight siblings finish, then stop launching the
   *    rest of the wave (their commits still fold).
   *  - `'kill'`: abort the in-flight siblings immediately, same as `aborted`.
   *
   * `aborted` ALWAYS kills immediately regardless of this knob.
   */
  readonly onFatal?: 'kill' | 'drain';
  /**
   * Hook invoked once per branch, with that branch's freshly-created {@link Runner}, BEFORE it
   * starts. The caller bridges it to the EventBus (`bridgeRunnerToEventBus(runner, bus, …)` with
   * `chainId = task-<id>`). The scheduler owns the runner lifecycle; the hook only observes.
   */
  readonly onBranchRunner?: (runner: Runner<TCtx>, branch: WaveBranch<TCtx>) => void;
}

/** Internal per-branch bookkeeping: the runner, a never-rejecting settle promise, captured error. */
interface BranchRun<TCtx> {
  readonly branch: WaveBranch<TCtx>;
  readonly runner: Runner<TCtx>;
  /** Resolves to this same run when the runner reaches a terminal state. Never rejects. */
  readonly settled: Promise<BranchRun<TCtx>>;
  /** The `failed`-event error, captured off the runner's stream; `null` for a clean / aborted run. */
  capturedError: DomainError | null;
}

/** Classify a settled branch error: `aborted` / `rate-limit` are fatal, everything else absorbed. */
const isFatal = (err: DomainError): boolean => !isRecoverableTurnError(err);

/**
 * Above-the-chain async orchestrator that drives N independent {@link Runner} instances — one per
 * {@link WaveBranch} — bounded by `maxConcurrency` (re-clamped `[1,5]`), wave by wave.
 *
 * **§14 — NOT an `Element`.** `runWaves` deliberately does not implement the `Element` interface
 * and must never be `.children`-walked or composed into a `sequential`/`loop`/`guard`. It sits
 * ABOVE the five chain primitives, sequencing whole sub-chains; the primitives stay untouched.
 *
 * Scheduling contract:
 *  - **Bounded fan-out.** Within a wave, at most `maxConcurrency` branches are in flight. A
 *    hand-rolled `Set<Promise>` + `Promise.race` drains the pool: launch up to the cap, race for
 *    the next settle, refill, repeat.
 *  - **Strictly sequential waves.** Wave `k+1` does not begin until EVERY branch of wave `k` has
 *    settled AND `config.merge` has folded them into the carried ctx.
 *  - **Deterministic trace.** The combined trace is assembled in branch-DECLARATION order across
 *    all waves — never completion order — so the trace is reproducible run to run.
 *
 * Failure contract (CLAUDE.md "AbortError is the one error chains propagate transparently"):
 *  - A NON-fatal branch failure is absorbed: siblings keep running, the error is captured in that
 *    branch's {@link BranchOutcome} (`status: 'failed'`) for the reducer to record as a block.
 *  - **Abort:** when `signal` aborts, forward it into every in-flight branch via
 *    `runner.abort()`, await all branches to settle (`Promise.allSettled` semantics — `settled`
 *    never rejects) so each branch's chain runs its own cleanup (e.g. worktree teardown), then
 *    return `Result.error({ error: AbortError, trace })` VERBATIM — the AbortError is never folded
 *    into a per-branch "blocked" outcome.
 *  - **Rate-limit:** an exhausted-retry `rate-limit` in one branch is fatal. With
 *    `onFatal: 'drain'` (default) the in-flight siblings finish and then the rest of the wave is
 *    not launched; with `onFatal: 'kill'` the siblings are aborted immediately. Either way the
 *    `rate-limit` error is returned verbatim once everything has settled.
 *
 * @public
 */
export const runWaves = async <TCtx>(
  waves: ReadonlyArray<ReadonlyArray<WaveBranch<TCtx>>>,
  initialCtx: TCtx,
  config: WaveScheduleConfig<TCtx>,
  signal?: AbortSignal
): Promise<Result<{ readonly ctx: TCtx; readonly trace: Trace }, ElementFailure>> => {
  const cap = clampConcurrency(config.maxConcurrency);
  const onFatal = config.onFatal ?? 'drain';

  const combinedTrace: Trace[] = [];
  let ctx = initialCtx;

  for (const wave of waves) {
    // Waves are STRICTLY sequential by design: wave k+1 must not start until every
    // branch of wave k has settled and `merge` has folded them into `ctx`.
    const waveResult = await runOneWave(wave, ctx, cap, onFatal, config, signal);

    // Append every started branch's trace in DECLARATION order — never completion order.
    combinedTrace.push(...waveResult.traces);

    if (waveResult.fatal !== null) {
      return Result.error({ error: waveResult.fatal, trace: combinedTrace.flat() });
    }

    ctx = config.merge(ctx, waveResult.outcomes);
  }

  return Result.ok({ ctx, trace: combinedTrace.flat() });
};

interface WaveResult<TCtx> {
  /** Settled outcomes for the branches that ran, in declaration order. */
  readonly outcomes: ReadonlyArray<BranchOutcome<TCtx>>;
  /** Per-started-branch traces, in declaration order. */
  readonly traces: readonly Trace[];
  /** A fatal error (`aborted`/`rate-limit`) that short-circuits the whole schedule, if any. */
  readonly fatal: DomainError | null;
}

/**
 * Run one wave with bounded fan-out. Returns the wave's settled outcomes + traces in declaration
 * order plus any fatal error that aborts the whole schedule.
 *
 * Pool drain: maintain a `Set<Promise<BranchRun>>` of in-flight settle promises (each resolves to
 * its owning run). Launch up to `cap`, `Promise.race` for the next settle, remove it, inspect for
 * a fatal error, then refill from the pending queue — until everything settled or a stop fired.
 */
const runOneWave = async <TCtx>(
  wave: ReadonlyArray<WaveBranch<TCtx>>,
  base: TCtx,
  cap: number,
  onFatal: 'kill' | 'drain',
  config: WaveScheduleConfig<TCtx>,
  signal?: AbortSignal
): Promise<WaveResult<TCtx>> => {
  // If the outer signal is already aborted, never launch a single branch.
  if (signal?.aborted) {
    return { outcomes: [], traces: [], fatal: new AbortError({ elementName: 'wave-scheduler' }) };
  }

  const pool = createWavePool(wave, base, cap, onFatal, config);

  // Forward an outer-signal abort into every in-flight branch. Abort always kills immediately
  // (regardless of `onFatal`); `settled` promises still resolve, so the drain below awaits every
  // branch's own cleanup before returning.
  const onAbort = (): void => pool.abortAll(new AbortError({ elementName: 'wave-scheduler' }));
  signal?.addEventListener('abort', onAbort, { once: true });

  pool.fill();
  while (pool.inFlightCount() > 0) {
    // The drain is inherently sequential — one settle at a time, then refill.
    const settledRun = await pool.next();
    pool.classify(settledRun);
    pool.fill();
  }

  signal?.removeEventListener('abort', onAbort);
  return pool.assemble();
};

/**
 * Encapsulates one wave's launch / drain state machine. Mutable by design (a pool of in-flight
 * promises is inherently stateful); kept out of `runOneWave` to keep that function's branching
 * within the cognitive-complexity budget.
 */
const createWavePool = <TCtx>(
  wave: ReadonlyArray<WaveBranch<TCtx>>,
  base: TCtx,
  cap: number,
  onFatal: 'kill' | 'drain',
  config: WaveScheduleConfig<TCtx>
) => {
  // Per-index slots → outcomes + traces assembled in declaration order regardless of completion
  // order. `undefined` = branch never started (drained / killed before launch).
  const runs: Array<BranchRun<TCtx> | undefined> = new Array(wave.length).fill(undefined);
  const inFlight = new Set<Promise<BranchRun<TCtx>>>();
  let nextIndex = 0;
  let fatal: DomainError | null = null;
  let stopLaunching = false;

  const launch = (index: number): void => {
    const run = createBranchRun(wave[index]!, base);
    runs[index] = run;
    config.onBranchRunner?.(run.runner, run.branch);
    inFlight.add(run.settled);
  };

  return {
    inFlightCount: (): number => inFlight.size,

    /** Launch branches up to the cap, unless a stop (fatal / abort) has fired. */
    fill: (): void => {
      while (nextIndex < wave.length && inFlight.size < cap && !stopLaunching) launch(nextIndex++);
    },

    /** Await the next settled branch and drop it from the in-flight set. */
    next: async (): Promise<BranchRun<TCtx>> => {
      const settledRun = await Promise.race(inFlight);
      inFlight.delete(settledRun.settled);
      return settledRun;
    },

    /** Classify a settled branch: record the first fatal, stop launching, kill siblings if needed. */
    classify: (settledRun: BranchRun<TCtx>): void => {
      const err = settledRun.capturedError;
      if (err === null || !isFatal(err)) return;
      if (fatal === null) fatal = err; // first fatal wins
      stopLaunching = true;
      // `aborted` always kills immediately; `rate-limit` honours `onFatal` ('drain' lets siblings finish).
      if (err.code === 'aborted' || onFatal === 'kill') {
        for (const run of runs) run?.runner.abort('fatal-sibling');
      }
    },

    /** Forward an outer-signal abort: record AbortError, stop launching, kill every branch now. */
    abortAll: (abortErr: AbortError): void => {
      stopLaunching = true;
      if (fatal === null) fatal = abortErr;
      for (const run of runs) run?.runner.abort('outer-signal-aborted');
    },

    /** Assemble outcomes + traces in declaration order once the wave has fully drained. */
    assemble: (): WaveResult<TCtx> => {
      const outcomes: Array<BranchOutcome<TCtx>> = [];
      const traces: Trace[] = [];
      // On an abort short-circuit we never fold branch outcomes — the AbortError returns verbatim.
      const abortedFatal = fatal !== null && fatal.code === 'aborted';
      for (const run of runs) {
        if (run === undefined) continue;
        traces.push(run.runner.trace);
        if (!abortedFatal) outcomes.push(toOutcome(run));
      }
      return { outcomes, traces, fatal };
    },
  };
};

/**
 * Create a branch's {@link Runner} and the `settled` promise that resolves (to the run itself)
 * when the runner terminates. The runner already wraps `element.execute` in
 * `runWithSession(id, …)` and owns its own `AbortController` + trace ring + listener set — so each
 * branch is fully isolated. `runner.start()` resolves on terminal and never rejects, so `settled`
 * never rejects either.
 */
const createBranchRun = <TCtx>(branch: WaveBranch<TCtx>, base: TCtx): BranchRun<TCtx> => {
  const runner = createRunner<TCtx>({ id: branch.id, element: branch.element, initialCtx: base });
  const run: BranchRun<TCtx> = {
    branch,
    runner,
    capturedError: null,
    // Placeholder; reassigned immediately below now that `run` exists to resolve to / capture onto.
    settled: Promise.resolve(undefined as unknown as BranchRun<TCtx>),
  };

  const unsub = runner.subscribe((event) => {
    if (event.type === 'failed') run.capturedError = event.error;
  });

  // start() resolves when the run reaches a terminal state; detach the listener then, resolve to
  // the run so the pool drain can identify the race winner and read its captured error.
  (run as { settled: Promise<BranchRun<TCtx>> }).settled = runner
    .start()
    .finally(unsub)
    .then(() => run);

  return run;
};

/** Map a terminal {@link Runner} to a {@link BranchOutcome}. */
const toOutcome = <TCtx>(run: BranchRun<TCtx>): BranchOutcome<TCtx> => {
  if (run.runner.status === 'completed') {
    return { id: run.branch.id, status: 'completed', ctx: run.runner.ctx };
  }
  // A NON-fatal failure is absorbed: capture the error so the reducer can record the block. A
  // runner that reports 'aborted' without a captured error was a fatal-sibling kill in 'kill'
  // mode (or an outer-signal abort) — surface it as a no-op `failed` with no error rather than
  // pretending it completed, so the reducer can leave the task to be reset/re-run.
  return {
    id: run.branch.id,
    status: 'failed',
    ctx: run.runner.ctx,
    ...(run.capturedError !== null ? { error: run.capturedError } : {}),
  };
};
