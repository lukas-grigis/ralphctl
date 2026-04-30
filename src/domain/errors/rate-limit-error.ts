/**
 * `RateLimitError` — raised when an AI provider CLI signals that the
 * caller has been rate-limited (HTTP 429 / 529 / "rate limit" / "too many
 * requests" / "overloaded" patterns in stderr or non-zero exit).
 *
 * Distinct from {@link StorageError} (a system-level read/write failure)
 * and {@link ParseError} (untrusted text could not be coerced). Rate-limit
 * is a *transient* upstream failure the executor / scheduler can recover
 * from by waiting and retrying — surfacing it as its own type lets the
 * pipeline pause-and-resume instead of treating it like a hard error.
 *
 * The `subCode` discriminator narrows the detection source:
 *  - `spawn-stderr` — provider stdout/stderr matched a rate-limit pattern
 *                     while the process was still running.
 *  - `spawn-exit`   — provider exited non-zero AND its captured stderr
 *                     matched a rate-limit pattern at close time. This is
 *                     the path the legacy executor used to capture session
 *                     IDs for resume after a 429.
 *
 * `retryAfterMs` is populated when the upstream surfaces a parseable
 * `Retry-After` value; otherwise the caller falls back to an exponential
 * default (the kernel's `RateLimitCoordinator` does not own that policy).
 *
 * Structurally compatible with the kernel's `KernelError` shape
 * (`{ code, message, cause? }`) so chain elements can propagate it without
 * translation.
 */
export type RateLimitErrorSubCode = 'spawn-stderr' | 'spawn-exit';

export interface RateLimitErrorOptions {
  readonly subCode: RateLimitErrorSubCode;
  readonly message?: string;
  readonly retryAfterMs?: number;
  /**
   * Provider-assigned session id captured at the moment of the 429, when
   * the underlying CLI surfaced one. The scheduler uses it to resume the
   * same conversation after the pause window elapses.
   */
  readonly sessionId?: string;
  readonly cause?: unknown;
}

export class RateLimitError extends Error {
  /** Discriminator. `as const` keeps it narrow at the type level. */
  readonly code = 'rate-limit' as const;
  /** Narrower failure family — see {@link RateLimitErrorSubCode}. */
  readonly subCode: RateLimitErrorSubCode;
  /** Suggested wait window before retry, in milliseconds. */
  readonly retryAfterMs: number | undefined;
  /** Provider session id, when surfaced — used by the scheduler to resume. */
  readonly sessionId: string | undefined;
  /** Wrapped lower-level error, when one exists. */
  override readonly cause: unknown;

  constructor(opts: RateLimitErrorOptions) {
    super(opts.message ?? defaultMessage(opts));
    this.name = 'RateLimitError';
    this.subCode = opts.subCode;
    this.retryAfterMs = opts.retryAfterMs;
    this.sessionId = opts.sessionId;
    this.cause = opts.cause;
  }
}

function defaultMessage(opts: RateLimitErrorOptions): string {
  const detail =
    opts.subCode === 'spawn-exit'
      ? 'provider exited with rate-limit signal'
      : 'rate-limit pattern detected in provider stderr';
  if (typeof opts.retryAfterMs === 'number' && Number.isFinite(opts.retryAfterMs)) {
    return `${detail} (retry after ${String(opts.retryAfterMs)}ms)`;
  }
  return detail;
}
