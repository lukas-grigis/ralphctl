import { Result } from 'typescript-result';
import type { AsyncResult } from 'typescript-result';
import type { ZodType, ZodError } from 'zod';
import { ValidationError } from '@src/errors.ts';

export type { AsyncResult };

/**
 * Wrap a Zod schema parse into a Result, converting ZodError into ValidationError.
 */
export function zodParse<T>(schema: ZodType<T>, data: unknown, label = '') {
  const parsed = schema.safeParse(data);
  if (parsed.success) {
    return Result.ok(parsed.data);
  }
  const zodErr = parsed.error as ZodError;
  return Result.error(new ValidationError(zodErr.message, label, zodErr));
}

/**
 * Wrap an async function that may throw into a Result.
 * @param fn       The async function to execute
 * @param mapError Converts a caught unknown error to the typed error E
 */
export async function wrapAsync<T, E>(fn: () => Promise<T>, mapError: (err: unknown) => E) {
  try {
    const value = await fn();
    return Result.ok(value);
  } catch (err) {
    return Result.error(mapError(err));
  }
}

/**
 * Normalize an unknown thrown value into an Error instance.
 */
export function ensureError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

/**
 * Unwrap a Result at a boundary (e.g. top-level CLI handler).
 * Throws the error if the result represents a failure.
 */
export function unwrapOrThrow<T>(result: Result<T, Error>): T {
  if (result.ok) {
    return result.value as T;
  }
  throw result.error;
}
