/**
 * `DomainError` — the closed union of every error shape the domain layer
 * can surface to its callers (use cases, repositories, chain leaves).
 *
 * This file is a **type-only** union — it deliberately does NOT re-export
 * the underlying classes. Re-exporting would make it a barrel, and the
 * project's no-barrel rule (every import points to its source module
 * directly) applies here too. Call sites that need to *construct* a
 * domain error import the concrete class from its own file; call sites
 * that only need to *type* one (return types, generic parameters) import
 * `DomainError` from here.
 *
 * Members are imported `type`-only so this module produces zero JS at
 * runtime.
 *
 * Every member is structurally compatible with the kernel's `KernelError`
 * shape (`{ code, message, cause? }`) — the kernel layer can propagate
 * any `DomainError` without translation.
 */
import type { CheckFailedError } from './check-failed-error.ts';
import type { ConflictError } from './conflict-error.ts';
import type { InvalidStateError } from './invalid-state-error.ts';
import type { NotFoundError } from './not-found-error.ts';
import type { ParseError } from './parse-error.ts';
import type { RateLimitError } from './rate-limit-error.ts';
import type { StorageError } from './storage-error.ts';
import type { ValidationError } from '@src/domain/values/validation-error.ts';

export type DomainError =
  | ValidationError
  | InvalidStateError
  | ConflictError
  | NotFoundError
  | ParseError
  | RateLimitError
  | StorageError
  | CheckFailedError;
