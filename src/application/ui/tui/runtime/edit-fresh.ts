import { Result } from '@src/domain/result.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';

/** Re-read → apply → save, so a prompt left open while a background flow wrote the entity never restores its stale snapshot. */
export const editFresh = async <T>(
  load: () => Promise<Result<T, DomainError>>,
  apply: (fresh: T) => Result<T, DomainError>,
  save: (next: T) => Promise<Result<void, DomainError>>
): Promise<Result<T, DomainError>> => {
  const fresh = await load();
  if (!fresh.ok) return Result.error(fresh.error);
  // typescript-result widens a generic Ok's value to a conditional type; T is exact here.
  const next = apply(fresh.value as T);
  if (!next.ok) return Result.error(next.error);
  const value = next.value as T;
  const saved = await save(value);
  return saved.ok ? (Result.ok(value) as Result<T, DomainError>) : Result.error(saved.error);
};
