import { ErrorCode } from '@src/domain/value/error/error-code.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';

import type { Element } from '@src/application/chain/element.ts';
import type { Trace, TraceEntry } from '@src/application/chain/trace.ts';
import { runWithSession } from '@src/application/session/session.ts';

export type RunnerStatus = 'idle' | 'running' | 'completed' | 'failed' | 'aborted';

/**
 * Event stream emitted as the chain progresses.
 *
 *  Successful run:  `started` → zero or more `step` → `completed`
 *  Failed run:      `started` → zero or more `step` → `failed`
 *  Aborted pre-run: `aborted` only (no `started`)
 *  Aborted mid-run: `started` → zero or more `step` → `aborted`
 */
export type RunnerEvent<TCtx> =
  | { readonly type: 'started' }
  | { readonly type: 'step'; readonly entry: TraceEntry }
  | { readonly type: 'completed'; readonly ctx: TCtx }
  | { readonly type: 'failed'; readonly error: DomainError }
  | { readonly type: 'aborted' };

export type RunnerListener<TCtx> = (event: RunnerEvent<TCtx>) => void;

export interface RunnerOptions<TCtx> {
  readonly id: string;
  readonly element: Element<TCtx>;
  readonly initialCtx: TCtx;
}

/**
 * Wraps a single `element.execute()` call with a status machine, event stream, and live trace.
 *
 *  - **Idempotent**: repeated `start()` returns the same promise; `abort()` is idempotent.
 *  - **Late subscribers**: a listener added after the runner reaches a terminal state receives
 *    a synthetic replay (each recorded `step` event, then the matching terminal event). Lets a
 *    UI re-attach to a finished background runner without racing the registration.
 */
export interface Runner<TCtx> {
  readonly id: string;
  readonly status: RunnerStatus;
  readonly ctx: TCtx;
  readonly trace: Trace;
  start(): Promise<void>;
  abort(reason?: string): void;
  subscribe(listener: RunnerListener<TCtx>): () => void;
}

/**
 * Cap on retained `runner.trace` entries — a ring buffer past this point. Long implement runs
 * (7+ tasks × multi-round × ~12 leaves each) can emit thousands of entries; live subscribers
 * still see every event (the trace cap only bounds the snapshot late subscribers replay from).
 *
 * Sized at ~1 MB worst case (each entry is ~200 bytes → 5000 × 200 B ≈ 1 MB). The durable
 * `<sprintDir>/chain.log` sink captures the full trace on disk, so post-mortem analysis can
 * always recover the full history outside of the in-memory snapshot. The execute view's
 * per-task round counter (in execute-view.tsx) holds a monotonic high-water mark in a ref so
 * the displayed `round N/M` survives eviction here. Other downstream consumers that scan
 * `runner.trace` directly (StepTrace's plan-merge, sprint-detail's attempt history) see only
 * what the trace currently holds — if a regression around truncated tails surfaces in one of
 * those views, the fix is to fall back to `chain.log` on disk rather than raising this cap.
 */
const MAX_TRACE_ENTRIES = 5_000;

export const createRunner = <TCtx>(opts: RunnerOptions<TCtx>): Runner<TCtx> => {
  const abortController = new AbortController();
  const listeners = new Set<RunnerListener<TCtx>>();

  let status: RunnerStatus = 'idle';
  let ctx: TCtx = opts.initialCtx;
  const trace: TraceEntry[] = [];
  let startPromise: Promise<void> | null = null;
  let failureError: DomainError | null = null;
  let abortRequested = false;

  const isTerminal = (): boolean => status === 'completed' || status === 'failed' || status === 'aborted';

  const emit = (event: RunnerEvent<TCtx>): void => {
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch (err) {
        // A thrown listener must not stall delivery to the rest of the subscriber set.
        console.warn('[chain-runner] listener threw:', err);
      }
    }
  };

  const replayTo = (listener: RunnerListener<TCtx>): void => {
    try {
      for (const entry of trace) listener({ type: 'step', entry });
      switch (status) {
        case 'completed':
          listener({ type: 'completed', ctx });
          break;
        case 'failed':
          if (failureError) listener({ type: 'failed', error: failureError });
          break;
        case 'aborted':
          listener({ type: 'aborted' });
          break;
        default:
          break;
      }
    } catch (err) {
      console.warn('[chain-runner] late subscriber threw on replay:', err);
    }
  };

  const run = async (): Promise<void> => {
    status = 'running';
    emit({ type: 'started' });

    const onTrace = (entry: TraceEntry): void => {
      trace.push(entry);
      if (trace.length > MAX_TRACE_ENTRIES) trace.splice(0, trace.length - MAX_TRACE_ENTRIES);
      emit({ type: 'step', entry });
    };

    // The runner is the chain's containment boundary: `leaf` deliberately re-propagates a
    // non-DomainError throw from a ctx projection as a programmer-error signal, and no composite
    // primitive catches it. Without this try/catch such a throw would reject `startPromise` — an
    // unhandled rejection that (on Node 24) kills the process mid-alt-screen with the runner stuck
    // in 'running' and no terminal event ever emitted, and would falsify the wave scheduler's
    // "start() never rejects" invariant. We convert it into a synthesized DomainError + 'failed'
    // event so the failure surfaces in the session instead of crashing the process — while keeping
    // the "throws are programmer errors" contract inside the chain.
    let error: DomainError;
    try {
      const result = await runWithSession(opts.id, () => opts.element.execute(ctx, abortController.signal, onTrace));

      if (result.ok) {
        ctx = result.value.ctx;
        status = 'completed';
        emit({ type: 'completed', ctx });
        return;
      }
      error = result.error.error;
    } catch (cause) {
      // An abort thrown raw (rather than returned as a Result) must still travel the abort path.
      if (cause instanceof Error && (cause as { code?: unknown }).code === ErrorCode.Aborted) {
        status = 'aborted';
        emit({ type: 'aborted' });
        return;
      }
      // Log loudly so a programmer-error throw stays visible even though it no longer crashes.
      console.error(`[chain-runner] element '${opts.element.name}' threw a non-DomainError:`, cause);
      const stack = cause instanceof Error ? cause.stack : undefined;
      error = new InvalidStateError({
        entity: `chain runner '${opts.id}'`,
        currentState: 'running',
        attemptedAction: `execute element '${opts.element.name}'`,
        message:
          `chain element '${opts.element.name}' threw a non-DomainError (programmer bug): ` +
          (cause instanceof Error ? cause.message : String(cause)),
        ...(stack !== undefined ? { hint: stack } : {}),
      });
    }

    // Distinguish caller-driven abort from underlying failures. A user who called `abort()`
    // always gets the 'aborted' status regardless of which error code surfaced.
    if (abortRequested || error.code === ErrorCode.Aborted) {
      status = 'aborted';
      emit({ type: 'aborted' });
      return;
    }

    failureError = error;
    status = 'failed';
    emit({ type: 'failed', error });
  };

  return {
    id: opts.id,
    get status() {
      return status;
    },
    get ctx() {
      return ctx;
    },
    get trace() {
      return trace;
    },

    start(): Promise<void> {
      if (startPromise !== null) return startPromise;
      // Aborted before start ever ran: stay in 'aborted', never emit `started`.
      if (status === 'aborted') {
        startPromise = Promise.resolve();
        return startPromise;
      }
      startPromise = run();
      return startPromise;
    },

    abort(reason?: string): void {
      if (abortRequested) return;
      abortRequested = true;
      if (status === 'idle') {
        status = 'aborted';
        emit({ type: 'aborted' });
        return;
      }
      if (isTerminal()) return;
      abortController.abort(reason);
    },

    subscribe(listener: RunnerListener<TCtx>): () => void {
      listeners.add(listener);
      if (isTerminal()) replayTo(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
};
