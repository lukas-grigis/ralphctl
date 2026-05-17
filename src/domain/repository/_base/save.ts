/**
 * Persist an entity — upsert semantics (creates or replaces atomically under the entity's
 * identity). The entity carries its own id; this capability does not need to know what the
 * id field is named.
 *
 * Returns `void` on success — saving is a side effect, not a transformation. If a backend
 * needs to surface a server-assigned id, it should compose `Save` with a separate
 * id-generator capability rather than smuggling the return value here.
 */

import type { Result } from '@src/domain/result.ts';
import type { Entity } from '@src/domain/entity/_base/entity.ts';
import type { StorageError } from '@src/domain/value/error/storage-error.ts';

export interface Save<E extends Entity<unknown>> {
  save(entity: E): Promise<Result<void, StorageError>>;
}
