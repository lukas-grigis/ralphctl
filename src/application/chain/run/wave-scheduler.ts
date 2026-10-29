import { Result } from '@src/domain/result.ts';
import { AbortError } from '@src/domain/value/error/abort-error.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import { isFatalChainError } from '@src/domain/value/error/is-fatal-chain-error.ts';

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
 *  - `status === 'completed'` → the branch's chain ran to a genuine terminal state; `ctx` is its
 *    real final ctx and `error` is absent. This is the ONLY status whose `ctx` is a transition
 *    worth overlaying onto anything.
 *  - `status === 'failed'`    → a NON-fatal branch error was absorbed. `ctx` here is the runner's
 *    OWN `initialCtx` — the runner (`runner.ts`) only ever reassigns its `ctx` on an ok step, so a
 *    failure NEVER partially advances it, whether or not `error` is present. A `merge` reducer must
 *    NOT read this `ctx` as if the branch settled something: it is the wave's PRE-branch state, not
 *    a transition, and it still carries every OTHER task in the wave too — overlaying it would
 *    revert not just this branch's own task but any sibling the branch's ctx happens to still be
 *    carrying, including one a DIFFERENT branch in the same wave already completed.
 *
 * Fatal errors (`aborted` / `rate-limit`) never surface as a `BranchOutcome` — they short-circuit
 * the whole wave (see {@link runWaves}).
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
   * Hook invoked once per branch, with that branch's freshly-created {@link Runner}, BEFORE it
   * starts. The caller bridges it to the EventBus (`bridgeRunnerToEventBus(runner, bus, …)` with
   * `chainId = task-<id>`). The scheduler owns the runner lifecycle; the hook only observes.
   */
  readonly onBranchRunner?: (runner: Runner<TCtx>, branch: WaveBranch<TCtx>) => void;
}

/** Internal per-branch bookkeeping: the runner and its captured terminal error. */
interface BranchRun<TCtx> {
  readonly branch: WaveBranch<TCtx>;
  readonly runner: Runner<TCtx>;
  /**
   * The terminal error captured off the runner's stream: the `failed` event's error, or the
   * `aborted` event's error when the abort originated INSIDE the branch chain. `null` for a clean
   * run and for a runner WE killed (fatal sibling / outer signal), whose `aborted` event carries
   * no error.
   */
  capturedError: DomainError | null;
}

/**
 * Above-the-chain async orchestrator that drives N independent {@link Runner} instances — one per
 * {@link WaveBranch} — bounded by `maxConcurrency` (re-clamped `[1,5]`), wave by wave.
 *
 * **NOT an `Element`.** `runWaves` deliberately does not implement the `Element` interface
 * and must never be `.children`-walked or composed into a `sequential`/`loop`/`guard`. It sits
 * ABOVE the five chain primitives, sequencing whole sub-chains; the primitives stay untouched.
 *
 * Scheduling contract:
 *  - **Bounded fan-out.** Within a wave, at most `maxConcurrency` branches are in flight: that many
 *    workers each launch the next pending branch as soon as their previous one settles.
 *  - **Strictly sequential waves.** Wave `k+1` does not begin until EVERY branch of wave `k` has
 *    settled AND `config.merge` has folded them into the carried ctx.
 *  - **Deterministic trace.** The combined trace is assembled in branch-DECLARATION order across
 *    all waves — never completion order — so the trace is reproducible run to run.
 *
 * Failure contract (CLAUDE.md "AbortError is the one error chains propagate transparently"):
 *  - A NON-fatal branch failure is absorbed: siblings keep running, and the error is captured in
 *    that branch's {@link BranchOutcome} (`status: 'failed'`) for diagnostics only. A reducer must
 *    not read a failed outcome's `ctx` or `error` as a task transition — see {@link BranchOutcome}.
 *  - **Abort:** when `signal` aborts — OR when a branch's own chain settles with an `aborted`-coded
 *    error (the operator answered "abort" at an in-branch prompt, with no outer signal) — forward
 *    it into every in-flight branch via `runner.abort()`, await all branches to settle
 *    (`Promise.allSettled` semantics — `settled` never rejects) so each branch's chain runs its own
 *    cleanup (e.g. worktree teardown), then return `Result.error({ error: AbortError, trace })`
 *    VERBATIM — the AbortError is never folded into a per-branch "blocked" outcome, and no later
 *    wave is launched.
 *  - **Rate-limit:** an exhausted-retry `rate-limit` in one branch is fatal. The in-flight
 *    siblings drain (finish, so their commits still fold) and the rest of the wave is not
 *    launched; the `rate-limit` error is returned verbatim once everything has settled.
 */
export const runWaves = async <TCtx>(
  waves: ReadonlyArray<ReadonlyArray<WaveBranch<TCtx>>>,
  initialCtx: TCtx,
  config: WaveScheduleConfig<TCtx>,
  signal?: AbortSignal
): Promise<Result<{ readonly ctx: TCtx; readonly trace: Trace }, ElementFailure>> => {
  const cap = clampConcurrency(config.maxConcurrency);

  const combinedTrace: Trace[] = [];
  let ctx = initialCtx;

  for (const wave of waves) {
    // Waves are STRICTLY sequential by design: wave k+1 must not start until every
    // branch of wave k has settled and `merge` has folded them into `ctx`.
    const waveResult = await runOneWave(wave, ctx, cap, config, signal);

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
 */
const runOneWave = async <TCtx>(
  wave: ReadonlyArray<WaveBranch<TCtx>>,
  base: TCtx,
  cap: number,
  config: WaveScheduleConfig<TCtx>,
  signal?: AbortSignal
): Promise<WaveResult<TCtx>> => {
  // If the outer signal is already aborted, never launch a single branch.
  if (signal?.aborted) {
    return { outcomes: [], traces: [], fatal: new AbortError({ elementName: 'wave-scheduler' }) };
  }

  // Per-index slots, so outcomes + traces assemble in declaration order. A hole = never started.
  const runs: Array<BranchRun<TCtx> | undefined> = new Array(wave.length);
  let next = 0;
  // Typed via `as` so TS doesn't narrow it to `null`: the closures below assign it.
  let fatal = null as DomainError | null;
  let stop = false;
  const killAll = (reason: string): void => {
    for (const run of runs) run?.runner.abort(reason);
  };

  // Record the first fatal (`aborted` / `rate-limit`) and stop launching; every other error is
  // absorbed into the branch's outcome.
  const classify = (run: BranchRun<TCtx>): void => {
    const err = run.capturedError;
    if (err === null || !isFatalChainError(err)) return;
    fatal ??= err;
    stop = true;
    // aborted kills at once; rate-limit drains so in-flight siblings finish and their commits still fold.
    if (err.code === 'aborted') killAll('fatal-sibling');
  };

  // An outer abort kills every branch now; their `settled` promises still resolve, so the
  // workers below await each branch's own cleanup before the wave returns.
  const onAbort = (): void => {
    stop = true;
    fatal ??= new AbortError({ elementName: 'wave-scheduler' });
    killAll('outer-signal-aborted');
  };
  signal?.addEventListener('abort', onAbort, { once: true });

  const worker = async (): Promise<void> => {
    while (!stop && next < wave.length) {
      const i = next++;
      const { run, settled } = startBranchRun(wave[i]!, base, config.onBranchRunner);
      runs[i] = run;
      classify(await settled);
    }
  };
  await Promise.all(Array.from({ length: Math.min(cap, wave.length) }, worker));
  signal?.removeEventListener('abort', onAbort);

  const started = runs.filter((run) => run !== undefined);
  return {
    // On an abort short-circuit we never fold branch outcomes — the AbortError returns verbatim.
    outcomes: fatal?.code === 'aborted' ? [] : started.map(toOutcome),
    traces: started.map((run) => run.runner.trace),
    fatal,
  };
};

/**
 * Start a branch's {@link Runner}; returns the run plus a never-rejecting settle promise that
 * resolves to that run when the runner terminates. The runner already wraps `element.execute` in
 * `runWithSession(id, …)` and owns its own `AbortController` + trace ring + listener set — so each
 * branch is fully isolated. `runner.start()` resolves on terminal and never rejects, so `settled`
 * never rejects either.
 */
const startBranchRun = <TCtx>(
  branch: WaveBranch<TCtx>,
  base: TCtx,
  onBranchRunner: WaveScheduleConfig<TCtx>['onBranchRunner']
): { readonly run: BranchRun<TCtx>; readonly settled: Promise<BranchRun<TCtx>> } => {
  const runner = createRunner<TCtx>({ id: branch.id, element: branch.element, initialCtx: base });
  // Before `start()`: a branch emits `started` (and any leading leaf start) synchronously.
  onBranchRunner?.(runner, branch);
  const run: BranchRun<TCtx> = { branch, runner, capturedError: null };

  const unsub = runner.subscribe((event) => {
    if (event.type === 'failed') run.capturedError = event.error;
    // An `aborted` event carrying an error means the BRANCH's own chain aborted (e.g. the operator
    // answered "abort" at an in-branch prompt) while the outer signal never fired. Capture it so
    // `classify` sees a fatal `aborted` and tears the schedule down instead of silently reading the
    // branch as "did not settle" and launching the rest of the wave — and every later wave. A kill
    // WE issued carries no error, so this stays a no-op for fatal-sibling / outer-signal aborts.
    else if (event.type === 'aborted' && event.error !== undefined) run.capturedError = event.error;
  });

  // start() resolves when the run reaches a terminal state; detach the listener then.
  return {
    run,
    settled: runner
      .start()
      .finally(unsub)
      .then(() => run),
  };
};

/** Map a terminal {@link Runner} to a {@link BranchOutcome}. */
const toOutcome = <TCtx>(run: BranchRun<TCtx>): BranchOutcome<TCtx> => {
  if (run.runner.status === 'completed') {
    return { id: run.branch.id, status: 'completed', ctx: run.runner.ctx };
  }
  // A NON-fatal failure is absorbed; its error rides along for diagnostics only. A runner that
  // reports 'aborted' without a captured error was killed by a sibling's abort (or an
  // outer-signal abort) — surfaced as a `failed` outcome with no error rather than as completed.
  // Either way `ctx` is the runner's untouched `initialCtx`, so a failed outcome contributes
  // nothing to the merge. Anything durable the branch wrote before it failed is recovered out of
  // band, from persisted state (the implement flow's `adopt-persisted-blocks` leaf), never here.
  return {
    id: run.branch.id,
    status: 'failed',
    ctx: run.runner.ctx,
    ...(run.capturedError !== null ? { error: run.capturedError } : {}),
  };
};
