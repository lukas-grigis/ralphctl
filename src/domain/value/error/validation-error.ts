import { ErrorCode } from '@src/domain/value/error/error-code.ts';

export interface ValidationErrorOptions {
  readonly field: string;
  readonly value: unknown;
  readonly message: string;
  readonly hint?: string;
}

export class ValidationError extends Error {
  readonly code = ErrorCode.InvalidValue;
  readonly field: string;
  readonly value: unknown;
  readonly hint?: string;

  constructor(opts: ValidationErrorOptions) {
    super(opts.message);
    this.name = 'ValidationError';
    this.field = opts.field;
    this.value = opts.value;
    if (opts.hint !== undefined) {
      this.hint = opts.hint;
    }
  }
}
