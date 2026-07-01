import type { AbortError } from '@src/domain/value/error/abort-error.ts';
import type { ValidationError } from '@src/domain/value/error/validation-error.ts';
import type { NotFoundError } from '@src/domain/value/error/not-found-error.ts';
import type { ConflictError } from '@src/domain/value/error/conflict-error.ts';
import type { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import type { MigrationGapError } from '@src/domain/value/error/migration-gap-error.ts';
import type { ParseError } from '@src/domain/value/error/parse-error.ts';
import type { ProbeError } from '@src/domain/value/error/probe-error.ts';
import type { ProcessCrashError } from '@src/domain/value/error/process-crash-error.ts';
import type { RateLimitError } from '@src/domain/value/error/rate-limit-error.ts';
import type { StorageError } from '@src/domain/value/error/storage-error.ts';

export type DomainError =
  | AbortError
  | ValidationError
  | NotFoundError
  | ConflictError
  | InvalidStateError
  | MigrationGapError
  | ParseError
  | ProbeError
  | ProcessCrashError
  | RateLimitError
  | StorageError;
