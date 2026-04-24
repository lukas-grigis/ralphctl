/**
 * Abstraction over the host process's signal-handler + shutdown lifecycle.
 *
 * The execute pipeline needs three things from the process manager:
 *   1. Install SIGINT/SIGTERM handlers eagerly, so Ctrl+C works before the
 *      first AI child is spawned.
 *   2. Observe whether a shutdown is in progress, so the scheduler can stop
 *      pulling new work mid-flight.
 *   3. Wire a task-scoped AbortSignal to a child-process terminate callback,
 *      so the abort of a single backgrounded execution SIGTERMs only its own
 *      children (not the whole host).
 *
 * Keeping this as a port lets business logic depend on an interface rather
 * than reaching into `src/integration/ai/session/process-manager.ts`
 * directly.
 */
export interface ProcessLifecyclePort {
  /** Idempotently install SIGINT/SIGTERM handlers. */
  ensureHandlers(): void;
  /** Returns true once a graceful shutdown sequence has begun. */
  isShuttingDown(): boolean;
  /**
   * Register `terminate` to run once when `signal` aborts. Returns a
   * disposer that detaches the listener (idempotent). If the signal is
   * already aborted the terminate runs on the next microtask.
   *
   * The disposer MUST be called in a `finally` after the spawn resolves so
   * listeners don't accumulate across repeated task runs.
   */
  registerAbort(signal: AbortSignal, terminate: () => void): () => void;
}
