/**
 * Session context — `AsyncLocalStorage`-backed scope that tags every
 * `logger.info(...)` / `signalBus.emit(...)` call made during chain
 * execution with the owning session id.
 *
 * Why ALS, not explicit threading:
 *  - `LoggerPort` is constructor-injected into use cases; threading a
 *    sessionId through every leaf would require either rebinding the
 *    logger via `.child({ sessionId })` at every chain boundary (noisy
 *    and easy to miss) or passing the id through every method signature
 *    (invasive across the entire business layer).
 *  - `signalBus.emit` happens deep inside provider adapters (rate-limit
 *    listeners) and the parser pipeline; those callers don't know which
 *    chain they're inside.
 *
 * The `ChainRunner` enters the scope around `element.execute(...)`. Any
 * async work inherited from `await` chains stays inside the same
 * `AsyncLocalStorage` store, so a `logger.info(...)` call made twelve
 * `await`s deep still reads the correct id.
 *
 * Outside any chain (one-shot CLI commands, `doctor`, plain-text
 * commands), `currentSessionId()` returns `undefined`. Consumers that
 * care about per-session filtering treat the global stream as untagged
 * — see `useLoggerEvents({ sessionId })` for the filter contract.
 *
 * Lives in `kernel/` because chain execution is a kernel concern;
 * adapters in `integration/` read from the same module.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

interface SessionContextStore {
  readonly sessionId: string;
}

const storage = new AsyncLocalStorage<SessionContextStore>();

/**
 * Run `fn` inside a session scope. Every `await` inside `fn` (and every
 * promise that descends from those awaits) reads `sessionId` from the
 * scope via {@link currentSessionId}.
 */
export function runWithSession<T>(sessionId: string, fn: () => Promise<T> | T): Promise<T> | T {
  return storage.run({ sessionId }, fn);
}

/**
 * Returns the session id of the currently-active chain execution scope,
 * or `undefined` when the caller is outside any chain (e.g. one-shot
 * CLI commands, the doctor view, the bootstrap rate-limit listener
 * fired before any chain has launched).
 */
export function currentSessionId(): string | undefined {
  return storage.getStore()?.sessionId;
}
