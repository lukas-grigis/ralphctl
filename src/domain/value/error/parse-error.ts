import { ErrorCode } from '@src/domain/value/error/error-code.ts';

export type ParseErrorSubCode = 'invalid-json' | 'schema-mismatch';

export interface ParseErrorOptions {
  readonly subCode: ParseErrorSubCode;
  readonly message: string;
  readonly cause?: unknown;
  readonly hint?: string;
}

export class ParseError extends Error {
  readonly code = ErrorCode.Parse;
  readonly subCode: ParseErrorSubCode;
  override readonly cause: unknown;
  readonly hint?: string;

  constructor(opts: ParseErrorOptions) {
    super(opts.message);
    this.name = 'ParseError';
    this.subCode = opts.subCode;
    this.cause = opts.cause;
    if (opts.hint !== undefined) {
      this.hint = opts.hint;
    }
  }
}
