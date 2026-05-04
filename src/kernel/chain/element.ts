import { Result } from 'typescript-result';

/**
 * Minimal structural error type the kernel understands.
 *
 * The kernel does not depend on `src/domain/`. Domain errors are expected
 * to satisfy this shape (they will, once they exist). Anything carrying at
 * least a string `code` and `message` is acceptable.
 */
export interface KernelError {
  readonly code: string;
  readonly message: string;
  readonly cause?: unknown;
}

/** Status of a single trace entry — one per element invocation. */
export type ChainTraceStatus = 'completed' | 'failed' | 'skipped' | 'aborted';

/** A single entry in a chain's execution trace. */
export interface ChainTraceEntry {
  readonly stepName: string;
  readonly status: ChainTraceStatus;
  readonly durationMs: number;
  readonly error?: KernelError;
}

/** Read-only execution trace returned by every element. */
export type ChainTrace = readonly ChainTraceEntry[];

/**
 * Optional progressive-trace callback. Implementations call this once per
 * element invocation, at the moment the entry becomes final. Composite
 * elements forward the callback to their children so the leaves report
 * progressively as they complete; the composite never reports a self-entry
 * (today's traces don't include wrapper-level entries).
 *
 * Synthetic entries the composite constructs itself (e.g. `'skipped'` for
 * children that didn't run, or `'aborted'` for the in-flight child when the
 * signal trips) MUST also be forwarded so the live event stream matches the
 * final trace.
 */
export type OnTraceCallback = (entry: ChainTraceEntry) => void;

/**
 * Optional progressive-ctx callback. Implementations call this whenever the
 * element produces a fresh context value — after each successful leaf body,
 * after each successful Sequential child, after a Retry attempt succeeds,
 * after an OnError fallback succeeds, etc.
 *
 * Subscribers (the {@link ChainRunner}) use this to keep `runner.ctx` live
 * during a run instead of frozen at the initial value until the chain
 * settles. UIs that read `runner.ctx` mid-flight (e.g. the live execute
 * dashboard's per-task panel reading `ctx.tasks`) get the freshest value
 * the framework has.
 *
 * Failure paths do NOT call `onCtxUpdate` — only successful transitions
 * produce a new ctx worth surfacing.
 */
export type OnCtxUpdateCallback<TCtx> = (ctx: TCtx) => void;

/** Successful element execution: new context plus the trace up to this point. */
export interface ElementSuccess<TCtx> {
  readonly ctx: TCtx;
  readonly trace: ChainTrace;
}

/** Failed element execution: the failing error plus the trace up to the failure. */
export interface ElementFailure {
  readonly error: KernelError;
  readonly trace: ChainTrace;
}

/**
 * Result returned by every {@link Element}.
 *
 * Both success and failure carry the trace — composite elements append their
 * children's traces to their own to produce a single linear story up to the
 * point of failure.
 */
export type ElementResult<TCtx> = Result<ElementSuccess<TCtx>, ElementFailure>;

/** Error thrown when a caller passes an already-aborted signal. */
const ABORT_ERROR: KernelError = {
  code: 'aborted',
  message: 'Operation aborted',
};

/**
 * Abstract base for every chain element.
 *
 * `execute()` is the public entry point. It is intentionally not overridable
 * by subclasses — it owns timing, tracing and abort wiring so every element
 * gets that boilerplate for free. Subclasses implement the protected
 * {@link Element.run} hook with the element-specific behaviour.
 *
 * The contract for `run`:
 * - Return `Result.ok({ ctx, trace })` on success. The trace must contain the
 *   entries the caller wants to surface (typically the element's own entry
 *   plus any child entries, in execution order).
 * - Return `Result.error({ error, trace })` on failure. The trace must end
 *   with the failing entry.
 * - Honour `signal.aborted` — return a failure whose final trace entry has
 *   `status: 'aborted'` and whose error code is `'aborted'`.
 *
 * Leaf elements (which don't compose children) can use the
 * {@link Element.runLeaf} helper below to avoid hand-rolling the timing and
 * trace-entry construction.
 */
export abstract class Element<TCtx> {
  public readonly name: string;

  // Note: not `protected` so subclasses without their own constructor can still
  // be instantiated. The class is `abstract`, which is what guarantees no
  // direct `new Element(...)` outside the inheritance tree.
  constructor(name: string) {
    this.name = name;
  }

  /**
   * Run the element. Final method — subclasses override {@link Element.run}
   * instead. The base wraps the call so callers see a uniform contract:
   * - Pre-aborted signals never invoke the body.
   * - Unexpected throws inside `run` are converted to a failure result.
   *
   * The optional `onTrace` callback receives each leaf-level trace entry the
   * moment it becomes final, so live UIs can render the trace progressively
   * instead of waiting for the whole chain to resolve. Composites forward
   * the callback to their children; leaves emit their own single entry via
   * {@link Element.runLeaf}.
   *
   * Backwards-compat: subclasses that override `run` with the old
   * `(ctx, signal)` signature silently drop `onTrace`. To keep listeners
   * from missing entries in that case, the base counts how many entries
   * were emitted through the wrapped callback. If `run` emitted nothing,
   * the base replays the final trace's entries before resolving. If `run`
   * emitted at least one entry, the base trusts the subclass and does
   * NOT replay (avoids double-counting in Retry, which renames child
   * entries onto fresh objects and stores fresh objects in its own
   * trace).
   */
  public async execute(
    ctx: TCtx,
    signal?: AbortSignal,
    onTrace?: OnTraceCallback,
    onCtxUpdate?: OnCtxUpdateCallback<TCtx>
  ): Promise<ElementResult<TCtx>> {
    let emittedCount = 0;
    const wrappedOnTrace: OnTraceCallback | undefined = onTrace
      ? (entry) => {
          emittedCount += 1;
          onTrace(entry);
        }
      : undefined;

    if (signal?.aborted) {
      const entry: ChainTraceEntry = {
        stepName: this.name,
        status: 'aborted' as const,
        durationMs: 0,
        error: ABORT_ERROR,
      };
      wrappedOnTrace?.(entry);
      return Result.error({
        error: ABORT_ERROR,
        trace: [entry],
      });
    }

    let result: ElementResult<TCtx>;
    try {
      result = await this.run(ctx, signal, wrappedOnTrace, onCtxUpdate);
    } catch (err) {
      const kernelError = toKernelError(err);
      const entry: ChainTraceEntry = {
        stepName: this.name,
        status: 'failed' as const,
        durationMs: 0,
        error: kernelError,
      };
      wrappedOnTrace?.(entry);
      return Result.error({
        error: kernelError,
        trace: [entry],
      });
    }

    // Backwards-compat replay: if the subclass produced a trace but never
    // forwarded onTrace, walk the final trace and emit entries now. Skips
    // when the subclass already emitted (count > 0) so Retry's renamed
    // entries aren't double-counted.
    if (onTrace && emittedCount === 0) {
      const trace = result.ok ? result.value.trace : result.error.trace;
      for (const entry of trace) onTrace(entry);
    }

    return result;
  }

  /**
   * Element-specific behaviour. Implementations MUST return a result that
   * carries a trace (even on failure). See class doc for details.
   *
   * The optional `onTrace` callback is forwarded by composites to their
   * children so leaves can emit progressively. Implementations that
   * synthesise trace entries themselves (e.g. composite skipped/aborted
   * entries) MUST also call `onTrace` for those entries.
   */
  protected abstract run(
    ctx: TCtx,
    signal?: AbortSignal,
    onTrace?: OnTraceCallback,
    onCtxUpdate?: OnCtxUpdateCallback<TCtx>
  ): Promise<ElementResult<TCtx>>;

  /**
   * Helper for leaf-style elements: time the body, build a single-entry
   * trace, and translate the body's `Result<TCtx, KernelError>` into an
   * {@link ElementResult}.
   *
   * The body receives `signal` so async work can short-circuit when the
   * caller cancels. If the body returns successfully but the signal aborted
   * mid-flight, the trace records `'aborted'`.
   *
   * If `onTrace` is provided, the resulting entry is reported through it
   * before the helper resolves — this is the seam that lets a live UI render
   * progress as each leaf settles.
   */
  protected async runLeaf(
    body: () => Promise<Result<TCtx, KernelError>>,
    signal?: AbortSignal,
    onTrace?: OnTraceCallback,
    onCtxUpdate?: OnCtxUpdateCallback<TCtx>
  ): Promise<ElementResult<TCtx>> {
    const start = performance.now();
    let result: Result<TCtx, KernelError>;
    try {
      result = await body();
    } catch (err) {
      const durationMs = performance.now() - start;
      const kernelError = toKernelError(err);
      const entry: ChainTraceEntry = {
        stepName: this.name,
        status: 'failed' as const,
        durationMs,
        error: kernelError,
      };
      onTrace?.(entry);
      return Result.error({
        error: kernelError,
        trace: [entry],
      });
    }

    const durationMs = performance.now() - start;

    if (signal?.aborted) {
      const abortErr: KernelError = ABORT_ERROR;
      const entry: ChainTraceEntry = {
        stepName: this.name,
        status: 'aborted' as const,
        durationMs,
        error: abortErr,
      };
      onTrace?.(entry);
      return Result.error({
        error: abortErr,
        trace: [entry],
      });
    }

    if (result.ok) {
      const successCtx = result.value as TCtx;
      const entry: ChainTraceEntry = {
        stepName: this.name,
        status: 'completed' as const,
        durationMs,
      };
      // ctx-update fires BEFORE the trace event so subscribers handling
      // the step event see the freshest ctx via runner.ctx — otherwise
      // the subscriber reads the stale value and the live UI lags one
      // step behind.
      onCtxUpdate?.(successCtx);
      onTrace?.(entry);
      return Result.ok({
        ctx: successCtx,
        trace: [entry],
      });
    }

    const failureError = result.error;
    const entry: ChainTraceEntry = {
      stepName: this.name,
      status: 'failed' as const,
      durationMs,
      error: failureError,
    };
    onTrace?.(entry);
    return Result.error({
      error: failureError,
      trace: [entry],
    });
  }
}

/**
 * Coerce an unknown thrown value into a {@link KernelError}.
 * Exported so subclasses can use the same conversion as the base.
 */
function toKernelError(err: unknown): KernelError {
  if (err && typeof err === 'object' && 'code' in err && 'message' in err) {
    const candidate = err;
    if (typeof candidate.code === 'string' && typeof candidate.message === 'string') {
      return err as KernelError;
    }
  }
  if (err instanceof Error) {
    return { code: 'unexpected', message: err.message, cause: err };
  }
  return { code: 'unexpected', message: String(err), cause: err };
}

/**
 * Build a `'skipped'` trace entry for a child that did not run.
 * Composite elements (Sequential, Parallel) use this to record short-circuited
 * children when an earlier failure aborts the rest.
 */
export function skippedEntry(stepName: string): ChainTraceEntry {
  return { stepName, status: 'skipped' as const, durationMs: 0 };
}
