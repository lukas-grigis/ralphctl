/**
 * Abstraction over the host process's signal-handler + shutdown lifecycle.
 *
 * The execute pipeline needs two things from the process manager:
 *   1. Install SIGINT/SIGTERM handlers eagerly, so Ctrl+C works before the
 *      first AI child is spawned.
 *   2. Observe whether a shutdown is in progress, so the scheduler can stop
 *      pulling new work mid-flight.
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
}
