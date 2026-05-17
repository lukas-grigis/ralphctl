import { ErrorCode } from '@src/domain/value/error/error-code.ts';

export type ProbeErrorSubCode = 'fs-read' | 'fs-permission' | 'malformed';

export interface ProbeErrorOptions {
  readonly subCode: ProbeErrorSubCode;
  readonly message: string;
  readonly path?: string;
  readonly cause?: unknown;
  readonly hint?: string;
}

/**
 * Surfaces a failure inside an readiness probe (filesystem read errored, permission denied,
 * or a parsed config file was malformed). Probes that simply find nothing return a successful
 * `Result.ok(absentState(...))` — `ProbeError` is reserved for cases where the probe could
 * not finish its work.
 */
export class ProbeError extends Error {
  readonly code = ErrorCode.Probe;
  readonly subCode: ProbeErrorSubCode;
  readonly path: string | undefined;
  override readonly cause: unknown;
  readonly hint?: string;

  constructor(opts: ProbeErrorOptions) {
    super(opts.message);
    this.name = 'ProbeError';
    this.subCode = opts.subCode;
    this.path = opts.path;
    this.cause = opts.cause;
    if (opts.hint !== undefined) {
      this.hint = opts.hint;
    }
  }
}
