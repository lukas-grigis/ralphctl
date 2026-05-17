import { ErrorCode } from '@src/domain/value/error/error-code.ts';

export type RateLimitErrorSubCode = 'spawn-stderr' | 'spawn-exit';

export interface RateLimitErrorOptions {
  readonly subCode: RateLimitErrorSubCode;
  readonly message?: string;
  readonly retryAfterMs?: number | undefined;
  readonly sessionId?: string | undefined;
  readonly cause?: unknown;
  readonly hint?: string;
}

export class RateLimitError extends Error {
  readonly code = ErrorCode.RateLimit;
  readonly subCode: RateLimitErrorSubCode;
  readonly retryAfterMs: number | undefined;
  readonly sessionId: string | undefined;
  override readonly cause: unknown;
  readonly hint?: string;

  constructor(opts: RateLimitErrorOptions) {
    super(opts.message ?? defaultMessage(opts));
    this.name = 'RateLimitError';
    this.subCode = opts.subCode;
    this.retryAfterMs = opts.retryAfterMs;
    this.sessionId = opts.sessionId;
    this.cause = opts.cause;
    if (opts.hint !== undefined) {
      this.hint = opts.hint;
    }
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
