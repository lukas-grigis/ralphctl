/**
 * Look-up-by-identity capability. Returns `NotFoundError` when the id is unknown — that's a
 * normal outcome, not an exception. Use cases that only need to read should depend on this
 * narrow interface rather than the full aggregate port.
 */

import type { Result } from '@src/domain/result.ts';
import type { Entity } from '@src/domain/entity/_base/entity.ts';
import type { NotFoundError } from '@src/domain/value/error/not-found-error.ts';
import type { StorageError } from '@src/domain/value/error/storage-error.ts';

export interface FindById<E extends Entity<I>, I> {
  findById(id: I): Promise<Result<E, NotFoundError | StorageError>>;
}
