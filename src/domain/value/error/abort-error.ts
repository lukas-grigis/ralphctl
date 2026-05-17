import { ErrorCode } from '@src/domain/value/error/error-code.ts';

export interface AbortErrorOptions {
  readonly elementName: string;
  readonly reason?: string;
}

/**
 * Cancellation surfaced through the chain runtime. Carries the step at which the abort was
 * observed so traces show the exact cancellation point.
 */
export class AbortError extends Error {
  readonly code = ErrorCode.Aborted;
  readonly elementName: string;
  readonly reason?: string;

  constructor(opts: AbortErrorOptions) {
    super(opts.reason ?? `operation aborted at step '${opts.elementName}'`);
    this.name = 'AbortError';
    this.elementName = opts.elementName;
    if (opts.reason !== undefined) {
      this.reason = opts.reason;
    }
  }
}
