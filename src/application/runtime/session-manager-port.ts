/**
 * `SessionManagerPort` — registry of concurrent chain executions.
 *
 * The runtime supports **N chains executing concurrently**. Each chain
 * runs as an independent session with its own `ChainRunner`. The session
 * manager owns the registry, lifecycle, and "which one is foregrounded"
 * marker that the UI consumes.
 *
 * Mental model: tmux windows. `start()` creates a window, `foreground()`
 * focuses one, `background()` detaches the focus, `kill()` closes one,
 * `list()` enumerates all.
 *
 * Type erasure at the registry boundary: per-session contexts are
 * generic on `start<TCtx>` but stored as `unknown` in the descriptor map.
 * The UI only consumes lifecycle events + display fields, so it doesn't
 * need the full type. Callers that need typed access should keep their
 * own typed handle to the runner returned by `start()`.
 */

import type { NotFoundError } from '../../domain/errors/not-found-error.ts';
import type { Result } from '../../domain/result.ts';
import type { IsoTimestamp } from '../../domain/values/iso-timestamp.ts';
import type { Element } from '../../kernel/chain/element.ts';
import type { ChainRunner } from '../../kernel/runtime/chain-runner.ts';

/** Per-chain session id minted by the SessionManager. */
export type SessionId = string;

/**
 * Lifecycle status of a session, mirrored from the underlying
 * `ChainRunner.status`. `idle` = registered but `start()` hasn't run yet
 * (a transient state — the manager calls `start()` synchronously after
 * registration). Terminal: `completed | failed | aborted`.
 */
export type SessionStatus = 'idle' | 'running' | 'completed' | 'failed' | 'aborted';

/**
 * Public-facing snapshot of one session. Immutable: a fresh descriptor
 * is published each time `status` changes so the UI can do reference
 * equality on re-renders.
 */
export interface SessionDescriptor<TCtx = unknown> {
  readonly id: SessionId;
  /** Human-readable label, set by the caller of `start()`. */
  readonly label: string;
  readonly status: SessionStatus;
  readonly startedAt: IsoTimestamp;
  readonly runner: ChainRunner<TCtx>;
}

/**
 * Events emitted by {@link SessionManagerPort}. Stream consumers (TUI
 * sessions view, CLI `sessions list`) reduce these into a presentation
 * state.
 *
 * Note: `status-changed` is intentionally absent — listeners that need
 * status updates should subscribe directly to the runner returned by
 * `get(id).runner`. The session manager focuses on registry-level events.
 */
export type SessionManagerEvent =
  | { readonly type: 'added'; readonly sessionId: SessionId }
  | { readonly type: 'removed'; readonly sessionId: SessionId }
  | { readonly type: 'active-changed'; readonly sessionId: SessionId | null };

export interface SessionManagerStartOptions<TCtx> {
  readonly label: string;
  readonly element: Element<TCtx>;
  readonly initialCtx: TCtx;
}

/**
 * Registry of `ChainRunner` instances representing live or completed
 * chains. Implementation: {@link SessionManager}.
 */
export interface SessionManagerPort {
  /**
   * Construct a `ChainRunner` for the element + initial context, register
   * it, kick off `runner.start()` in the background, and return the new
   * `SessionId`. The id can be used immediately to attach / inspect.
   *
   * Emits `{ type: 'added' }`. Does **not** emit `active-changed` — the
   * caller must invoke `foreground()` to make the new session active.
   */
  start<TCtx>(opts: SessionManagerStartOptions<TCtx>): SessionId;

  /** Returns descriptors in insertion order. */
  list(): readonly SessionDescriptor[];

  get(id: SessionId): SessionDescriptor | undefined;

  /**
   * Mark a session as the active one (UI focus). Emits `active-changed`
   * with the id. No-op + Result.ok if the session is already active.
   */
  foreground(id: SessionId): Result<void, NotFoundError>;

  /**
   * Drop the active marker. Emits `active-changed` with `null` when this
   * id was the current active session. No-op + Result.ok otherwise.
   */
  background(id: SessionId): Result<void, NotFoundError>;

  /**
   * Abort the runner (if still running) and remove the descriptor.
   *
   * The abort propagates synchronously, but the actual cleanup of the
   * runner state happens asynchronously when the runner settles. The
   * descriptor is removed and the `removed` event fires immediately —
   * the runner promise continues in the background and is awaited only
   * by `dispose()`.
   *
   * Emits `removed`, plus `active-changed` with `null` when the killed
   * session was the active one.
   */
  kill(id: SessionId): Result<void, NotFoundError>;

  /** Currently foregrounded session, if any. */
  readonly active: SessionDescriptor | null;

  /**
   * Register a listener for registry events. Returns an unsubscribe
   * function. Listener errors never stall delivery to the rest of the
   * subscriber set — they are logged via `console.warn` (the same
   * "pre-logger infrastructure" exception used in `signal-bus.ts` and
   * `chain-runner.ts`).
   */
  subscribe(listener: (event: SessionManagerEvent) => void): () => void;

  /**
   * Abort every live runner, await each one's start promise to settle,
   * clear subscribers and the registry. Idempotent.
   */
  dispose(): Promise<void>;
}
