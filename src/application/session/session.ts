import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * `AsyncLocalStorage`-backed scope that tags every `logger.info(...)` and `publishSignal(...)`
 * made during chain execution with the owning session id.
 *
 * Why ALS, not explicit threading:
 *  - Logger / publish ports are constructor-injected; threading `sessionId` through every leaf
 *    would either require rebinding via `.child({ sessionId })` at every chain boundary
 *    (noisy and easy to miss) or passing the id through every method signature (invasive
 *    across the whole business layer).
 *  - `publishSignal` happens deep inside provider adapters that don't know which chain
 *    they're inside.
 *
 * The chain runner enters the scope around `element.execute(...)`. Any async work inherited
 * via `await` stays inside the same store. Outside any chain (one-shot CLI commands, doctor),
 * `currentSessionId()` returns `undefined` and consumers treat the stream as untagged.
 *
 * Scopes NEST (parallel implement runs one branch runner per task inside the host runner's
 * scope, plus prologue / epilogue sub-runners), so the store carries two ids: `sessionId` is
 * innermost-wins (per-branch attribution) and `rootSessionId` is the outermost runner id
 * (what the TUI keys a whole session by). See {@link rootSessionId}.
 */

interface SessionStore {
  readonly sessionId: string;
  /** Outermost `runWithSession` id of this scope chain — see {@link rootSessionId}. */
  readonly rootSessionId: string;
}

const storage = new AsyncLocalStorage<SessionStore>();

/**
 * Enter a session scope. Nesting is legitimate — the parallel implement path runs each task on
 * its own branch runner inside the host runner's scope, and the prologue / epilogue segments run
 * on sub-runners — so an entered scope SHADOWS `sessionId` (innermost wins, which is what
 * per-branch logger / signal attribution needs) while INHERITING `rootSessionId` from the scope
 * it was entered from.
 */
export const runWithSession = <T>(sessionId: string, fn: () => Promise<T> | T): Promise<T> | T =>
  storage.run({ sessionId, rootSessionId: storage.getStore()?.rootSessionId ?? sessionId }, fn);

export const currentSessionId = (): string | undefined => storage.getStore()?.sessionId;

/**
 * The OUTERMOST runner id of the active scope — the id a nested runner inherits rather than
 * replaces. Use this (not {@link currentSessionId}) for anything the TUI keys on by SESSION
 * rather than by branch: the Execute view is mounted with the host runner's id, so a
 * `token-usage` event stamped with a branch id (`task-<taskId>`) can never be looked up.
 *
 * On the serial path — one runner, no nesting — this equals `currentSessionId()`.
 *
 * @public
 */
export const rootSessionId = (): string | undefined => storage.getStore()?.rootSessionId;
