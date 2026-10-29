import { ErrorCode } from '@src/domain/value/error/error-code.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';

import type { Element } from '@src/application/chain/element.ts';
import type { StepStart, Trace, TraceEntry } from '@src/application/chain/trace.ts';
import { runWithSession } from '@src/application/session/session.ts';
import { messageOf } from '@src/domain/value/error/error-message.ts';

export type RunnerStatus = 'idle' | 'running' | 'completed' | 'failed' | 'aborted';

/**
 * Event stream emitted as the chain progresses.
 *
 *  Successful run:  `started` → zero or more `step` → `completed`
 *  Failed run:      `started` → zero or more `step` → `failed`
 *  Aborted pre-run: `aborted` only (no `started`)
 *  Aborted mid-run: `started` → zero or more `step` → `aborted`
 *
 * `step-started` precedes the `step` of every leaf that actually ran its work (never a skipped,
 * pre-aborted or synthesised entry). Several can be open at once under parallel branches. It is
 * live-only: late subscribers get no replay of it, because only in-flight state needs it.
 *
 * `aborted` carries an `error` ONLY when the abort originated INSIDE the chain — the element
 * returned (or threw) an `aborted`-coded error of its own, e.g. the operator answered "abort" at an
 * in-chain prompt. A caller-driven `abort()` (Ctrl-C, an outer signal, a fatal-sibling kill) omits
 * it: the caller already knows it cancelled, and there is no branch error to propagate. The wave
 * scheduler relies on exactly that distinction to tell "this branch's operator aborted the run"
 * from "I killed this branch".
 */
export type RunnerEvent<TCtx> =
  | { readonly type: 'started' }
  | { readonly type: 'step-started'; readonly step: StepStart }
  | { readonly type: 'step'; readonly entry: TraceEntry }
  | { readonly type: 'completed'; readonly ctx: TCtx }
  | { readonly type: 'failed'; readonly error: DomainError }
  | { readonly type: 'aborted'; readonly error?: DomainError };

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
  /** The element this runner executes — lets callers walk its plan tree without running it. */
  readonly element: Element<TCtx>;
  readonly status: RunnerStatus;
  readonly ctx: TCtx;
  readonly trace: Trace;
  start(): Promise<void>;
  abort(reason?: string): void;
  subscribe(listener: RunnerListener<TCtx>): () => void;
}

/**
 * Ring-buffer cap on `runner.trace` (~1 MB): it bounds only the snapshot late subscribers replay;
 * live subscribers see every event and chain.log holds the full trace. A view that needs an
 * evicted entry should read chain.log, not raise this cap.
 */
const MAX_TRACE_ENTRIES = 5_000;

// One closure on purpose: status, ctx, trace and the abort flag are one state machine whose
// invariants (no `started` after `abort()`, exactly one terminal event) stay locally checkable.
// eslint-disable-next-line max-lines-per-function -- deliberate; see KERNEL-DESIGN.md "The runner"
export const createRunner = <TCtx>(opts: RunnerOptions<TCtx>): Runner<TCtx> => {
  const abortController = new AbortController();
  const listeners = new Set<RunnerListener<TCtx>>();

  let status: RunnerStatus = 'idle';
  let ctx: TCtx = opts.initialCtx;
  const trace: TraceEntry[] = [];
  let startPromise: Promise<void> | null = null;
  let failureError: DomainError | null = null;
  /** The chain's own `aborted`-coded error, when the abort came from INSIDE the chain. */
  let abortError: DomainError | null = null;
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

  const abortedEvent = (): RunnerEvent<TCtx> =>
    abortError === null ? { type: 'aborted' } : { type: 'aborted', error: abortError };

  /**
   * Enter the `aborted` terminal. `error` is the chain's own abort error, if any; it is dropped
   * when the abort was caller-driven (`abort()` / outer signal), because then the cancellation is
   * the caller's, not a branch failure to hand back up.
   */
  const settleAborted = (error?: DomainError): void => {
    status = 'aborted';
    abortError = abortRequested || error === undefined ? null : error;
    emit(abortedEvent());
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
          listener(abortedEvent());
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
    const onStart = (step: StepStart): void => emit({ type: 'step-started', step });

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
      const result = await runWithSession(
        opts.id,
        () => opts.element.execute(ctx, abortController.signal, onTrace, onStart),
        abortController.signal
      );

      if (result.ok) {
        ctx = result.value.ctx;
        status = 'completed';
        emit({ type: 'completed', ctx });
        return;
      }
      error = result.error.error;
    } catch (cause) {
      // An abort thrown raw (rather than returned as a Result) must still travel the abort path —
      // carrying the thrown error, so an in-chain abort stays distinguishable from a caller kill.
      if (cause instanceof Error && (cause as { code?: unknown }).code === ErrorCode.Aborted) {
        settleAborted(cause as DomainError);
        return;
      }
      // Log loudly so a programmer-error throw stays visible even though it no longer crashes.
      console.error(`[chain-runner] element '${opts.element.name}' threw a non-DomainError:`, cause);
      const stack = cause instanceof Error ? cause.stack : undefined;
      error = new InvalidStateError({
        entity: `chain runner '${opts.id}'`,
        currentState: 'running',
        attemptedAction: `execute element '${opts.element.name}'`,
        message: `chain element '${opts.element.name}' threw a non-DomainError (programmer bug): ` + messageOf(cause),
        ...(stack !== undefined ? { hint: stack } : {}),
      });
    }

    // Distinguish caller-driven abort from underlying failures. A user who called `abort()`
    // always gets the 'aborted' status regardless of which error code surfaced.
    if (abortRequested || error.code === ErrorCode.Aborted) {
      settleAborted(error);
      return;
    }

    failureError = error;
    status = 'failed';
    emit({ type: 'failed', error });
  };

  return {
    id: opts.id,
    element: opts.element,
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
        settleAborted();
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
