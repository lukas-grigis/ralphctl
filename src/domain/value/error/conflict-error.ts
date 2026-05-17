import { ErrorCode } from '@src/domain/value/error/error-code.ts';

export interface ConflictErrorOptions {
  readonly entity: string;
  readonly field: string;
  readonly value: unknown;
  readonly message?: string;
  readonly hint?: string;
}

export class ConflictError extends Error {
  readonly code = ErrorCode.Conflict;
  readonly entity: string;
  readonly field: string;
  readonly value: unknown;
  readonly hint?: string;

  constructor(opts: ConflictErrorOptions) {
    super(opts.message ?? `${opts.entity} with ${opts.field} '${String(opts.value)}' already exists`);
    this.name = 'ConflictError';
    this.entity = opts.entity;
    this.field = opts.field;
    this.value = opts.value;
    if (opts.hint !== undefined) {
      this.hint = opts.hint;
    }
  }
}
