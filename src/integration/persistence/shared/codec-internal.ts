import type { z } from 'zod';
import { Result } from '@src/domain/result.ts';
import { ParseError } from '@src/domain/value/error/parse-error.ts';

/**
 * Mutual-assignability check between a domain interface and a zod-inferred shape. Both
 * directions of `extends` must hold. Note: this is intentionally lenient — `field?: T` and
 * `field?: T | undefined` are treated as compatible because they round-trip equivalently
 * through JSON. Strict structural identity is not the goal; drift detection is.
 *
 * Round-trip tests in `domain/__tests__/codec/` are the authoritative correctness check; this
 * type-level guard is a soft tripwire that catches obvious shape changes during refactors.
 */
type Widen<T> =
  T extends ReadonlyArray<infer U>
    ? ReadonlyArray<Widen<U>>
    : T extends object
      ? { [K in keyof T]-?: Widen<T[K]> | undefined }
      : T;
export type Compatible<A, B> = [Widen<A>] extends [Widen<B>] ? ([Widen<B>] extends [Widen<A>] ? true : false) : false;

/**
 * Run a zod schema's `safeParse` and convert the failure into the domain's {@link ParseError}.
 * Subcode is always `'schema-mismatch'` — `'invalid-json'` is the I/O boundary's concern, not
 * the codec's. Codecs accept already-parsed `unknown`.
 */
export const safeParseToResult = <T, Schema extends z.ZodType>(
  schema: Schema,
  input: unknown
): Result<T, ParseError> => {
  const result = schema.safeParse(input);
  if (!result.success) {
    return Result.error(
      new ParseError({
        subCode: 'schema-mismatch',
        message: result.error.message,
        cause: result.error,
      })
    );
  }
  return Result.ok(result.data as T) as Result<T, ParseError>;
};
