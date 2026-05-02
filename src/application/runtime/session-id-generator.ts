/**
 * Per-session id generator used by {@link SessionManager}.
 *
 * One id is minted every time `SessionManager.start()` registers a new
 * `ChainRunner`. This is **distinct** from the per-process id in
 * `runtime/session-id.ts`:
 *
 *  - `runtime/session-id.ts` → one id per CLI invocation, used to name
 *    `<logsDir>/<sessionId>.jsonl`.
 *  - `runtime/session-id-generator.ts` → one id per chain registered with
 *    the SessionManager (a single CLI invocation can host N).
 *
 * The shape — 8 lowercase hex characters — matches the legacy UUID8
 * convention used elsewhere in the codebase, so an id can be displayed
 * directly in the TUI session list and copy-pasted into
 * `ralphctl sessions attach <id>` without re-encoding.
 */

import type { SessionId } from './session-manager-port.ts';

/**
 * Default generator: take the first 8 hex chars of a v4 UUID, lowercased.
 * `crypto.randomUUID()` is available in Node 24+ (the project's minimum)
 * without any import — it's part of the Web Crypto API mounted on
 * `globalThis.crypto`.
 */
export function defaultSessionIdGenerator(): SessionId {
  // crypto.randomUUID() returns "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".
  // Slicing the first 8 characters keeps just the random prefix.
  return globalThis.crypto.randomUUID().slice(0, 8).toLowerCase();
}
