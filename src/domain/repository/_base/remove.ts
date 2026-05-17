/**
 * Delete capability — remove by identity. `NotFoundError` when the id is unknown; callers
 * that want "remove if exists" semantics can branch on that error rather than have the
 * repository second-guess them.
 */

import type { Result } from '@src/domain/result.ts';
import type { NotFoundError } from '@src/domain/value/error/not-found-error.ts';
import type { StorageError } from '@src/domain/value/error/storage-error.ts';

export interface Remove<I> {
  remove(id: I): Promise<Result<void, NotFoundError | StorageError>>;
}
