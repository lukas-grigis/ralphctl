/**
 * Enumerate all entities of the aggregate. No pagination — UUIDv7 ids are timestamp-prefixed
 * and lex-sortable, so callers that want "the N most recent" use {@link listLatest} (a free
 * function over `ListAll<E>`) rather than another repository method.
 *
 * If a backend later genuinely needs paged reads (huge datasets, slow store) it should define
 * a separate `ListPage<E>` capability instead of widening this one — callers that don't need
 * paging shouldn't be forced to thread query objects through every layer.
 */

import type { Result } from '@src/domain/result.ts';
import type { Entity } from '@src/domain/entity/_base/entity.ts';
import type { StorageError } from '@src/domain/value/error/storage-error.ts';

export interface ListAll<E extends Entity<unknown>> {
  list(): Promise<Result<readonly E[], StorageError>>;
}
