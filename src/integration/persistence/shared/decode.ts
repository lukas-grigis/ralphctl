import { Result } from '@src/domain/result.ts';
import type { ParseError } from '@src/domain/value/error/parse-error.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';

/**
 * Apply a codec's `fromJson*` to raw input and convert any `ParseError` into a
 * `StorageError(subCode: 'parse')` with the on-disk path attached. Repositories use this so
 * decode failures surface as a uniform storage problem rather than leaking the codec's
 * `ParseError` shape upward.
 */
export const decode = <T>(
  fromJson: (input: unknown) => Result<T, ParseError>,
  input: unknown,
  context: { readonly entity: string; readonly path: string }
): Result<T, StorageError> => {
  const decoded = fromJson(input);
  if (!decoded.ok) {
    return Result.error(
      new StorageError({
        subCode: 'parse',
        message: `failed to decode ${context.entity} at ${context.path}`,
        path: context.path,
        cause: decoded.error,
      })
    );
  }
  return Result.ok(decoded.value as T) as Result<T, StorageError>;
};
