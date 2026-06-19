import { Result } from '@src/domain/result.ts';
import { AbortError } from '@src/domain/value/error/abort-error.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import type { Task } from '@src/domain/entity/task.ts';
import type { TaskId } from '@src/domain/value/id/task-id.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';

import type { Element, ElementResult } from '@src/application/chain/element.ts';
import type { OnTrace, TraceEntry } from '@src/application/chain/trace.ts';
import { createRunner, type Runner } from '@src/application/chain/run/runner.ts';
import { combineAbortSignals } from '@src/application/chain/run/combine-signals.ts';
import { runWaves, type WaveBranch } from '@src/application/chain/run/wave-scheduler.ts';
import { bridgeRunnerToEventBus } from '@src/application/observability/chain-runner-bridge.ts';
import type { EventBus } from '@src/business/observability/event-bus.ts';
import type { FileLocker } from '@src/integration/io/file-locker.ts';
import { repoLockFile } from '@src/integration/io/lock-paths.ts';

import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';
import type { ImplementWavePlan } from '@src/application/flows/implement/flow.ts';
import { mergeImplementWave } from '@src/application/flows/implement/merge-wave.ts';

/** Static config the parallel orchestrator needs beyond the wave plan + branch builder. */
export interface ParallelImplementConfig {
  readonly fileLocker: FileLocker;
  readonly locksRoot: AbsolutePath;
  readonly eventBus: EventBus;
  /** Clamped `[1,5]` `settings.concurrency.maxParallelTasks` — passed verbatim to `runWaves`. */
  readonly maxConcurrency: number;
  /** `flowId` for the per-branch + per-segment EventBus bridge — always `'implement'`. */
  readonly flowId: string;
  /** Stable id factory for the prologue / epilogue sub-runners (distinct from branch ids). */
  readonly sessionId: () => string;
  /**
   * Builds the per-wave branch arrays — injected so the orchestrator is testable without the full
   * per-task subchain. The launcher passes `() => buildWaveBranches(deps, opts, plan.waves, …)`.
   * Each branch element forks the carried ctx onto its worktree at EXECUTE time, so this factory is
   * called ONCE; the branch elements are reusable across the run.
   */
  readonly buildWaves: () => ReadonlyArray<ReadonlyArray<WaveBranch<ImplementCtx>>>;
}

const PARALLEL_ELEMENT_NAME = 'implement-parallel';

/**
 * The `>1` parallel implement orchestrator. A hand-written {@link Element} — NOT a chain
 * primitive (§14: `runWaves` is the above-the-chain scheduler, this element only sequences the
 * prologue / waves / epilogue around it). The launcher runs it on ONE `createRunner` so the TUI
 * subscribes to a single runner, exactly as it does for the serial path.
 *
 * Everything runs under ONE held `fileLocker.withLock(<sprint-dir lock>)` — the lock is
 * hoisted to the launcher for the parallel path; the serial path keeps it inside the flow. The
 * same lock KEY the serial path uses (`repoLockFile(locksRoot, sprintDir)`) so a serial and a
 * parallel run of the same sprint still mutually exclude.
 *
 * Sequence inside the lock:
 *
 *   1. prologue runner — `plan.prologue` over the incoming ctx (load → setup → preflight). On
 *      failure the prologue's error propagates; the epilogue still runs (below) so any pre-existing
 *      `tasks.json` survives, but no waves ran.
 *   2. `runWaves(branches, prologueCtx, { merge: mergeImplementWave, onFatal: 'drain', … }, signal)`
 *      — fans one branch per task per wave; each branch folds onto the shared sprint branch through
 *      the single fold queue.
 *   3. epilogue runner — ALWAYS runs, on the partially-merged ctx, even when `runWaves` returned an
 *      abort / fatal error (THE B4 durability gate). The epilogue's `saveTasksLeaf` persists every
 *      task whose commit was folded before the failure, so those commits are recorded in
 *      `tasks.json` and never re-execute as duplicates on relaunch.
 *
 * After the epilogue, the `runWaves` error (AbortError verbatim, or a rate-limit) propagates so the
 * sprint stays runnable — in-progress / un-settled tasks reset to `todo` on the next launch via the
 * existing resume logic.
 *
 * @public
 */
export const createParallelImplementElement = (
  plan: ImplementWavePlan,
  config: ParallelImplementConfig
): Element<ImplementCtx> => ({
  name: PARALLEL_ELEMENT_NAME,
  async execute(ctx, signal, onTrace): Promise<ElementResult<ImplementCtx>> {
    const lockPath = repoLockFile(config.locksRoot, plan.lockKey);
    if (!lockPath.ok) {
      const entry: TraceEntry = {
        elementName: PARALLEL_ELEMENT_NAME,
        status: 'failed',
        durationMs: 0,
        error: lockPath.error,
      };
      onTrace?.(entry);
      return Result.error({ error: lockPath.error, trace: [entry] });
    }

    const acquired = await config.fileLocker.withLock(lockPath.value, async (lockSignal) =>
      runUnderLock(plan, config, ctx, combineAbortSignals(signal, lockSignal), onTrace)
    );
    if (!acquired.ok) {
      // Lock contention — surface verbatim. No waves ran, nothing to persist.
      const entry: TraceEntry = {
        elementName: PARALLEL_ELEMENT_NAME,
        status: 'failed',
        durationMs: 0,
        error: acquired.error,
      };
      onTrace?.(entry);
      return Result.error({ error: acquired.error, trace: [entry] });
    }
    return acquired.value;
  },
});

/**
 * The body that runs INSIDE the held lock: prologue → waves → epilogue (always). Split out so the
 * lock-acquisition branching stays small. The held lock is released by `withLock`'s `finally` only
 * after this resolves — so the epilogue persist completes under the lock.
 */
const runUnderLock = async (
  plan: ImplementWavePlan,
  config: ParallelImplementConfig,
  ctx: ImplementCtx,
  signal: AbortSignal | undefined,
  onTrace: OnTrace | undefined
): Promise<ElementResult<ImplementCtx>> => {
  // ── Prologue ────────────────────────────────────────────────────────────────────────────────
  const prologue = await runSubElement(plan.prologue, ctx, config, signal, onTrace);
  if (!prologue.ok) {
    // Prologue failed (e.g. dirty tree, setup script non-zero, abort). No waves ran. Still run the
    // epilogue so any pre-existing `tasks.json` is re-saved verbatim under the lock, then propagate.
    await runSubElement(plan.epilogue, ctx, config, undefined, onTrace);
    return prologue;
  }
  const prologueCtx = prologue.value.ctx;

  // ── Waves ───────────────────────────────────────────────────────────────────────────────────
  // Accumulate each branch's DURABLY-SETTLED task copy as branches reach a terminal state. A branch
  // whose runner COMPLETED ran its fold step to completion (commit landed, or fold-conflict → the
  // task settled `blocked`) — its `runner.ctx.tasks` is authoritative. We capture this independently
  // of `runWaves` because on an aborted wave `runWaves` returns the AbortError verbatim WITHOUT the
  // partially-merged ctx (it never folds the aborted wave's outcomes). This map is the launcher's
  // own record of "what actually folded", used to build the epilogue ctx on the abort/fatal path —
  // THE B4 durability gate.
  const durablyFolded = new Map<TaskId, Task>();
  const waves = config.buildWaves();

  // GUARANTEED-teardown registry. Every per-branch EventBus subscription (the bus bridge AND the
  // durable-fold capture) is captured here so a `finally` can force-detach the lot when the wave
  // call resolves — even if a branch never delivered a clean terminal (rate-limit drain, fatal-
  // sibling kill race, mid-wave abort). The per-listener self-detach still fires on a clean
  // terminal; this is the belt to that braces. Without it, a branch that does NOT self-detach
  // leaves its closure permanently on the process-wide EventBus, pinning its runner → forked
  // ImplementCtx → trace ring for the whole TUI session (THE primary leak).
  const branchUnsubs = new Set<() => void>();

  let wavesResult: Awaited<ReturnType<typeof runWaves<ImplementCtx>>>;
  try {
    wavesResult = await runWaves<ImplementCtx>(
      waves,
      prologueCtx,
      {
        maxConcurrency: config.maxConcurrency,
        merge: mergeImplementWave,
        onFatal: 'drain',
        onBranchRunner: (runner) => {
          branchUnsubs.add(
            bridgeRunnerToEventBus(runner as Runner<unknown>, config.eventBus, { flowId: config.flowId })
          );
          branchUnsubs.add(captureDurableFold(runner, durablyFolded));
        },
      },
      signal
    );
  } finally {
    // Force-detach every per-branch subscription. Detach is idempotent (each unsub is a Set.delete
    // that no-ops once already removed), so calling it after a branch already self-detached is safe.
    // This runs on success, failure, AND abort/throw — re-throw (if any) propagates unchanged, so
    // an AbortError is never swallowed here.
    for (const unsub of branchUnsubs) unsub();
    branchUnsubs.clear();
  }

  // ── Epilogue (ALWAYS — the B4 durability gate) ────────────────────────────────────────────────
  // On success: persist `runWaves`'s fully-merged ctx. On abort/fatal: persist the prologue ctx
  // overlaid with whatever branches durably folded BEFORE the failure, so their `done` (or
  // `blocked`) status is recorded and their commits never re-execute as duplicates.
  const epilogueCtx = wavesResult.ok ? wavesResult.value.ctx : overlayDurable(prologueCtx, durablyFolded);
  const epilogue = await runSubElement(plan.epilogue, epilogueCtx, config, undefined, onTrace);

  if (!wavesResult.ok) {
    // Propagate the `runWaves` error VERBATIM (AbortError stays an AbortError so the sprint stays
    // runnable). The epilogue already persisted the durable folds above.
    return Result.error(wavesResult.error);
  }
  // Epilogue failure on the success path is a real persistence error — surface it.
  if (!epilogue.ok) return epilogue;
  return Result.ok({ ctx: epilogue.value.ctx, trace: [] });
};

/**
 * Subscribe to a branch runner and capture its DURABLY-SETTLED task copies into the shared overlay
 * once it reaches a terminal state. ONLY a runner that `completed` is captured: a `completed`
 * branch ran its fold step to the end, so its task either folded (`done`) or fold-conflicted
 * (`blocked`) — either way the transition is durable. An `aborted` / `failed` branch is skipped so
 * its task falls back to `base` (resets to `todo` and re-runs).
 *
 * Returns the runner-subscription unsub so the wave-level guaranteed teardown can force-detach it
 * if the branch never delivered a terminal event. The listener self-detaches on a clean terminal;
 * the returned unsub is the belt to that braces (idempotent — calling it twice is a no-op).
 */
const captureDurableFold = (runner: Runner<ImplementCtx>, into: Map<TaskId, Task>): (() => void) => {
  const unsub = runner.subscribe((event) => {
    if (event.type !== 'completed') {
      if (event.type === 'failed' || event.type === 'aborted') unsub();
      return;
    }
    for (const task of event.ctx.tasks ?? []) into.set(task.id, task);
    unsub();
  });
  return unsub;
};

/** Overlay the durably-folded task copies onto a base ctx's `tasks` by id (the abort-path epilogue ctx). */
const overlayDurable = (base: ImplementCtx, folded: ReadonlyMap<TaskId, Task>): ImplementCtx => {
  if (base.tasks === undefined) return base;
  return { ...base, tasks: base.tasks.map((t) => folded.get(t.id) ?? t) };
};

/**
 * Run one of the plan's segment elements (prologue / epilogue) on its OWN sub-runner, bridge it to
 * the EventBus, and re-emit its trace through the host `onTrace` so the TUI rail + chain.log see the
 * sub-steps inline. Returns the segment's terminal {@link ElementResult}. The sub-runner's own
 * `AbortController` is wired to the host signal so a host abort tears the segment down too.
 *
 * Why a sub-runner rather than `element.execute(ctx, signal, onTrace)` directly: the sub-runner
 * gives the segment its own `runWithSession` scope + EventBus bridge (`chain-started` / `-completed`
 * events), matching how the serial path's single runner frames the whole chain. The prologue and
 * epilogue thus appear as their own bridged chains, which the TUI already knows how to render.
 */
const runSubElement = async (
  element: Element<ImplementCtx>,
  initialCtx: ImplementCtx,
  config: ParallelImplementConfig,
  signal: AbortSignal | undefined,
  onTrace: OnTrace | undefined
): Promise<ElementResult<ImplementCtx>> => {
  const runner = createRunner<ImplementCtx>({ id: config.sessionId(), element, initialCtx });
  // Capture the bridge unsub (previously discarded — the sub-runner leak). The bridge self-detaches
  // on the sub-runner's own terminal, but if `runner.start()` throws (programmer-error path) the
  // self-detach never fires; the `finally` below force-detaches both subscriptions so neither the
  // bridge nor the trace listener lingers on the EventBus / runner.
  const unsubBridge = bridgeRunnerToEventBus(runner as Runner<unknown>, config.eventBus, { flowId: config.flowId });
  // Re-emit every sub-step through the host onTrace so the host trace stays continuous, and capture
  // a `failed` event's error off the stream (the runner does not expose its failure error directly).
  const captured: TraceEntry[] = [];
  let failureError: DomainError | undefined;
  const unsubTrace = runner.subscribe((event) => {
    if (event.type === 'step') {
      captured.push(event.entry);
      onTrace?.(event.entry);
    } else if (event.type === 'failed') {
      failureError = event.error;
    }
  });
  // Forward a host abort into the sub-runner.
  const onAbort = (): void => runner.abort('host-aborted');
  if (signal?.aborted) runner.abort('host-aborted');
  else signal?.addEventListener('abort', onAbort, { once: true });

  try {
    await runner.start();
  } finally {
    // Guaranteed teardown — runs on resolve, reject, and abort. Detach is idempotent, so this is
    // safe even after the bridge already self-detached on terminal. AbortError (if `start()` ever
    // rethrew one) is never caught here, so it propagates unchanged.
    signal?.removeEventListener('abort', onAbort);
    unsubTrace();
    unsubBridge();
  }

  if (runner.status === 'completed') return Result.ok({ ctx: runner.ctx, trace: captured });
  // Aborted or failed: synthesise the failure result. `aborted` → AbortError (propagated verbatim
  // upstream so the sprint stays runnable); `failed` → the captured failure error off the stream.
  const error: DomainError =
    runner.status === 'aborted' || failureError === undefined
      ? new AbortError({ elementName: element.name })
      : failureError;
  return Result.error({ error, trace: captured });
};
