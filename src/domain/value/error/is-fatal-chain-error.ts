import { ErrorCode } from '@src/domain/value/error/error-code.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';

/**
 * The two error codes that must tear down an entire chain rather than be absorbed into a
 * per-branch / per-task block:
 *
 *   - `Aborted`   — user cancellation (Ctrl-C / TUI abort). Absorbing it would swallow the cancel;
 *                   an abort always propagates verbatim.
 *   - `RateLimit` — the provider adapter already exhausted its internal 429 retries. Continuing
 *                   would only re-hit the same limit, so the run stops instead.
 *
 * Every other domain error is recoverable at the call site's discretion: the failure is recorded
 * and the surrounding work carries on.
 *
 * @public
 */
export const isFatalChainError = (err: DomainError): boolean =>
  err.code === ErrorCode.Aborted || err.code === ErrorCode.RateLimit;
