import { Result } from '@src/domain/result.ts';
import { ValidationError } from '@src/domain/value/error/validation-error.ts';

/**
 * Parse an optional string field that, when provided, must be non-empty after trimming.
 * `undefined` passes through as `undefined`. Whitespace-only is rejected (callers should
 * omit the field rather than pass an empty string).
 */
export const parseOptionalString = (
  field: string,
  value: string | undefined
): Result<string | undefined, ValidationError> => {
  if (value === undefined) return Result.ok(undefined);
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return Result.error(
      new ValidationError({
        field,
        value,
        message: `${field} must be non-empty when provided`,
        hint: 'omit the field instead of passing an empty string',
      })
    );
  }
  return Result.ok(trimmed);
};
