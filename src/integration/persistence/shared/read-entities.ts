import { Result } from '@src/domain/result.ts';
import type { MigrationGapError } from '@src/domain/value/error/migration-gap-error.ts';
import { NotFoundError } from '@src/domain/value/error/not-found-error.ts';
import type { ParseError } from '@src/domain/value/error/parse-error.ts';
import type { StorageError } from '@src/domain/value/error/storage-error.ts';
import { readJson } from '@src/integration/io/fs.ts';
import { decode } from '@src/integration/persistence/shared/decode.ts';
import { NAME_SEPARATOR } from '@src/integration/persistence/storage.ts';

type FromJson<T> = (input: unknown, path: string) => Result<T, ParseError | MigrationGapError>;

/** One directory entry's raw read, as produced by a repository's `list()` scan. */
export interface EntityRead {
  /** The directory entry name — slugged `<id>--<slug>` (canonical) or legacy bare `<id>`. */
  readonly name: string;
  readonly path: string;
  readonly json: Result<unknown, NotFoundError | StorageError>;
}

/**
 * Decode a listing's reads, deduped by id. A legacy bare entry and its slugged sibling can coexist
 * after a crash mid-reconcile, so the slugged (canonical) entry wins explicitly; a read that vanished
 * between list and read is skipped.
 */
export const decodeDeduped = <T>(
  reads: readonly EntityRead[],
  fromJson: FromJson<T>,
  entity: string,
  idOf: (value: T) => string
): Result<readonly T[], StorageError> => {
  const byId = new Map<string, T>();
  const canonicalIds = new Set<string>();
  for (const { name, path, json } of reads) {
    if (!json.ok) {
      if (json.error instanceof NotFoundError) continue; // race, or a stray entry without its file
      return Result.error(json.error);
    }
    const decoded = decode((input) => fromJson(input, path), json.value, { entity, path });
    if (!decoded.ok) return Result.error(decoded.error);
    const value = decoded.value as T; // typescript-result widens a narrowed generic value; T is exact here
    const id = idOf(value);
    const isCanonical = name.includes(NAME_SEPARATOR);
    if (!isCanonical && canonicalIds.has(id)) continue; // slugged sibling already read — it wins
    byId.set(id, value);
    if (isCanonical) canonicalIds.add(id);
  }
  return Result.ok([...byId.values()]);
};

/** Read and decode one entity file; an unresolved path or a missing file is a `NotFoundError` for `entity`/`id`. */
export const readEntity = async <T>(
  path: string | undefined,
  fromJson: FromJson<T>,
  entity: string,
  id: string
): Promise<Result<T, NotFoundError | StorageError>> => {
  if (path === undefined) return Result.error(new NotFoundError({ entity, id }));
  const json = await readJson(path);
  if (!json.ok) {
    if (json.error instanceof NotFoundError) return Result.error(new NotFoundError({ entity, id }));
    return Result.error(json.error);
  }
  return decode((input) => fromJson(input, path), json.value, { entity, path });
};
