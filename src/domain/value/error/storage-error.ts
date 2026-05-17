import { ErrorCode } from '@src/domain/value/error/error-code.ts';

export type StorageErrorSubCode = 'io' | 'lock' | 'parse' | 'schema-mismatch' | 'no-changes';

export interface StorageErrorOptions {
  readonly subCode: StorageErrorSubCode;
  readonly message: string;
  readonly path?: string;
  readonly cause?: unknown;
  readonly hint?: string;
}

export class StorageError extends Error {
  readonly code = ErrorCode.Storage;
  readonly subCode: StorageErrorSubCode;
  readonly path: string | undefined;
  override readonly cause: unknown;
  readonly hint?: string;

  constructor(opts: StorageErrorOptions) {
    super(opts.message);
    this.name = 'StorageError';
    this.subCode = opts.subCode;
    this.path = opts.path;
    this.cause = opts.cause;
    if (opts.hint !== undefined) {
      this.hint = opts.hint;
    }
  }
}
