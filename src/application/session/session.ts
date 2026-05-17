import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * `AsyncLocalStorage`-backed scope that tags every `logger.info(...)` and `signalSink.emit(...)`
 * made during chain execution with the owning session id.
 *
 * Why ALS, not explicit threading:
 *  - Logger / sink ports are constructor-injected; threading `sessionId` through every leaf
 *    would either require rebinding via `.child({ sessionId })` at every chain boundary
 *    (noisy and easy to miss) or passing the id through every method signature (invasive
 *    across the whole business layer).
 *  - `signalSink.emit` happens deep inside provider adapters that don't know which chain
 *    they're inside.
 *
 * The chain runner enters the scope around `element.execute(...)`. Any async work inherited
 * via `await` stays inside the same store. Outside any chain (one-shot CLI commands, doctor),
 * `currentSessionId()` returns `undefined` and consumers treat the stream as untagged.
 */

interface SessionStore {
  readonly sessionId: string;
}

const storage = new AsyncLocalStorage<SessionStore>();

export const runWithSession = <T>(sessionId: string, fn: () => Promise<T> | T): Promise<T> | T =>
  storage.run({ sessionId }, fn);

export const currentSessionId = (): string | undefined => storage.getStore()?.sessionId;
