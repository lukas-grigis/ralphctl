import type { ChainTrace, ChainTraceEntry, Element, KernelError } from '@src/kernel/chain/element.ts';
import { runWithSession } from './session-context.ts';

/** Lifecycle status of a {@link ChainRunner}. */
export type ChainRunnerStatus = 'idle' | 'running' | 'completed' | 'failed' | 'aborted';

/**
 * Event emitted by {@link ChainRunner} as its underlying chain progresses.
 *
 * Order on a successful run: `started` → zero or more `step` → `completed`.
 * Order on a failed run: `started` → zero or more `step` → `failed`.
 * Order when aborted before start: `aborted` only (no `started`).
 * Order when aborted during run: `started` → zero or more `step` → `aborted`.
 */
export type ChainRunnerEvent<TCtx> =
  | { readonly type: 'started' }
  | { readonly type: 'step'; readonly entry: ChainTraceEntry }
  | { readonly type: 'completed'; readonly ctx: TCtx }
  | { readonly type: 'failed'; readonly error: KernelError }
  | { readonly type: 'aborted' };

/** Listener for runner events. */
export type ChainRunnerListener<TCtx> = (event: ChainRunnerEvent<TCtx>) => void;

/** Constructor options for a {@link ChainRunner}. */
export interface ChainRunnerOptions<TCtx> {
  readonly id: string;
  readonly element: Element<TCtx>;
  readonly initialCtx: TCtx;
}

/**
 * Wraps one `Element.execute()` call with a status machine, an event stream,
 * and a live trace.
 *
 * Trace exposure: subscribers attached BEFORE `start()` receive each `step`
 * event the moment the underlying leaf settles, via the kernel's `onTrace`
 * hook (see {@link OnTraceCallback}). The runner accumulates the same
 * entries into `currentTrace` as they arrive so `runner.trace` is a
 * live-growing array during the run.
 *
 * Idempotency: `start()` returns the same in-flight (or already-resolved)
 * promise on repeated calls. `abort()` is also idempotent.
 *
 * Late subscribers: a listener added after the runner reaches a terminal
 * state immediately receives a synthetic replay (`step*` then the matching
 * terminal event). This lets the UI re-attach to a background runner and
 * recover its outcome without racing the listener registration against the
 * run.
 */
export class ChainRunner<TCtx> {
  public readonly id: string;
  private readonly element: Element<TCtx>;
  private readonly abortController = new AbortController();
  private readonly listeners = new Set<ChainRunnerListener<TCtx>>();

  private currentStatus: ChainRunnerStatus = 'idle';
  private currentCtx: TCtx;
  private currentTrace: ChainTrace = [];
  private startPromise: Promise<void> | null = null;
  // Cached error so late subscribers can recover the failure outcome.
  private failureError: KernelError | null = null;
  // True once the user called abort() — used to disambiguate
  // "abort BEFORE start" from "abort during run".
  private abortRequested = false;

  constructor(opts: ChainRunnerOptions<TCtx>) {
    this.id = opts.id;
    this.element = opts.element;
    this.currentCtx = opts.initialCtx;
  }

  public get status(): ChainRunnerStatus {
    return this.currentStatus;
  }

  public get trace(): ChainTrace {
    return this.currentTrace;
  }

  public get ctx(): TCtx {
    return this.currentCtx;
  }

  /**
   * Start executing the chain. Idempotent: subsequent calls return the same
   * promise as the first call. Calling after a terminal state returns a
   * resolved promise; the runner does not re-execute.
   */
  public start(): Promise<void> {
    if (this.startPromise !== null) return this.startPromise;

    // Aborted before start ever ran: stay in 'aborted' (set by abort()),
    // never emit `started`, never run the element. Match the brief.
    if (this.currentStatus === 'aborted') {
      this.startPromise = Promise.resolve();
      return this.startPromise;
    }

    this.startPromise = this.run();
    return this.startPromise;
  }

  /**
   * Signal the underlying chain to abort. Pre-start, this short-circuits
   * `start()` so the chain never runs. Mid-run, the abort propagates through
   * the kernel's standard `AbortSignal` plumbing.
   */
  public abort(reason?: string): void {
    // `reason` is part of the public surface but not yet plumbed into the
    // AbortController; once the kernel chain framework supports a typed
    // abort reason we'll forward this through. For now it's documentation.
    void reason;
    if (this.abortRequested) return;
    this.abortRequested = true;

    // Pre-start: flip straight to 'aborted' and emit.
    if (this.currentStatus === 'idle') {
      this.currentStatus = 'aborted';
      this.emit({ type: 'aborted' });
      return;
    }

    // Already terminal — nothing to do; the controller is already drained.
    if (this.isTerminal()) return;

    // Running: trigger the controller; the run() promise will settle to
    // 'aborted' and emit on its own.
    this.abortController.abort();
  }

  /**
   * Subscribe to runner events. If the runner is already in a terminal
   * state, the listener is invoked synchronously with the matching synthetic
   * event before `subscribe` returns. Returns an unsubscribe function.
   */
  public subscribe(listener: ChainRunnerListener<TCtx>): () => void {
    this.listeners.add(listener);
    // Late-subscriber synthetic terminal event so re-attaching UIs can
    // recover state without racing.
    if (this.isTerminal()) {
      this.deliverTerminalReplay(listener);
    }
    return () => {
      this.listeners.delete(listener);
    };
  }

  private async run(): Promise<void> {
    this.currentStatus = 'running';
    this.emit({ type: 'started' });

    // Live trace accumulator: each leaf reports through onTrace as it
    // settles, so subscribers attached before start() see progress in real
    // time. We mirror those entries into currentTrace so runner.trace is a
    // live-growing snapshot during the run.
    const liveTrace: ChainTraceEntry[] = [];
    this.currentTrace = liveTrace;
    const onTrace = (entry: ChainTraceEntry): void => {
      liveTrace.push(entry);
      this.emit({ type: 'step', entry });
    };

    // Live ctx tracker: each leaf calls onCtxUpdate after applying its
    // output transformer; Sequential threads ctx through to the next
    // child; Retry / OnError forward ctx from a successful attempt /
    // fallback. Mirroring those updates into `currentCtx` keeps
    // `runner.ctx` live during the run
    // (instead of frozen at the initial value until completion), so UIs
    // reading `runner.ctx` mid-flight (e.g. the live execute view's
    // per-task panel) see fresh data without needing the launcher to
    // pre-seed every consumed field on initialCtx.
    const onCtxUpdate = (ctx: TCtx): void => {
      this.currentCtx = ctx;
    };

    // Tag every `logger.info(...)` / `signalBus.emit(...)` call made during
    // this chain run with the runner's id. See `session-context.ts` for the
    // ALS contract — adapters (`InkSink`, `InMemorySignalBus`) read from
    // `currentSessionId()` and stamp the event so the live TUI can filter
    // by descriptor.id without bleeding events between concurrent sessions.
    const result = await runWithSession(this.id, () =>
      this.element.execute(this.currentCtx, this.abortController.signal, onTrace, onCtxUpdate)
    );

    // Settle the trace to the result's trace (it's the canonical, ordered
    // record). On the happy path this matches what we accumulated; on
    // edge cases (composites synthesising entries in unusual orders) the
    // result's trace remains authoritative for late-subscriber replay.
    if (result.ok) {
      this.currentTrace = result.value.trace;
      this.currentCtx = result.value.ctx;
      this.currentStatus = 'completed';
      this.emit({ type: 'completed', ctx: this.currentCtx });
      return;
    }

    this.currentTrace = result.error.trace;

    // Distinguish caller-driven abort from the chain's own failures. The
    // kernel uses `error.code === 'aborted'` for cancellation, but a user
    // who called `abort()` always gets the 'aborted' status even if the
    // child happened to fail with a different code.
    if (this.abortRequested || result.error.error.code === 'aborted') {
      this.currentStatus = 'aborted';
      this.emit({ type: 'aborted' });
      return;
    }

    this.failureError = result.error.error;
    this.currentStatus = 'failed';
    this.emit({ type: 'failed', error: result.error.error });
  }

  private deliverTerminalReplay(listener: ChainRunnerListener<TCtx>): void {
    // Replay step entries first so the listener sees the same shape it would
    // have seen during the live run.
    try {
      for (const entry of this.currentTrace) {
        listener({ type: 'step', entry });
      }
      switch (this.currentStatus) {
        case 'completed':
          listener({ type: 'completed', ctx: this.currentCtx });
          break;
        case 'failed':
          // failureError is set whenever currentStatus === 'failed'.
          if (this.failureError) listener({ type: 'failed', error: this.failureError });
          break;
        case 'aborted':
          listener({ type: 'aborted' });
          break;
        default:
          // 'idle' / 'running' shouldn't reach here because isTerminal()
          // gates the call, but stay defensive.
          break;
      }
    } catch (err) {
      // Same console-warn rationale as in RateLimitCoordinator: subscriber
      // throws never propagate.
      console.warn('[chain-runner] late subscriber threw on replay:', err);
    }
  }

  private emit(event: ChainRunnerEvent<TCtx>): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (err) {
        // The kernel is normally console-silent. This is the same allowed
        // exception as RateLimitCoordinator: a thrown listener must not
        // stall delivery to the rest of the subscriber set.
        console.warn('[chain-runner] listener threw:', err);
      }
    }
  }

  private isTerminal(): boolean {
    return this.currentStatus === 'completed' || this.currentStatus === 'failed' || this.currentStatus === 'aborted';
  }
}
