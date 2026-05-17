/**
 * Return the N most-recently-created entities. Relies on the UUIDv7 contract: every aggregate
 * id is timestamp-prefixed, so the lex-descending sort of ids equals reverse-chronological
 * order — no separate `createdAt` field needed.
 *
 * Free function (not on `ListAll`) so adapters only have to implement one method (`list`); this
 * helper does the slicing in memory.
 */

import { Result } from '@src/domain/result.ts';
import type { Entity } from '@src/domain/entity/_base/entity.ts';
import type { ListAll } from '@src/domain/repository/_base/list-all.ts';
import type { StorageError } from '@src/domain/value/error/storage-error.ts';

export const listLatest = async <E extends Entity<string>>(
  repo: ListAll<E>,
  n: number
): Promise<Result<readonly E[], StorageError>> => {
  const all = await repo.list();
  if (!all.ok) return Result.error(all.error);
  const sorted = [...all.value].sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  return Result.ok(sorted.slice(0, Math.max(0, n)));
};
