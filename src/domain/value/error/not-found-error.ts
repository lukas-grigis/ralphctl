import { ErrorCode } from '@src/domain/value/error/error-code.ts';

export interface NotFoundErrorOptions {
  readonly entity: string;
  readonly id: string;
  readonly message?: string;
  readonly hint?: string;
}

export class NotFoundError extends Error {
  readonly code = ErrorCode.NotFound;
  readonly entity: string;
  readonly id: string;
  readonly hint?: string;

  constructor(opts: NotFoundErrorOptions) {
    super(opts.message ?? `${opts.entity} '${opts.id}' not found`);
    this.name = 'NotFoundError';
    this.entity = opts.entity;
    this.id = opts.id;
    if (opts.hint !== undefined) {
      this.hint = opts.hint;
    }
  }
}
