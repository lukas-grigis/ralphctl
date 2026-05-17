import { Result } from '@src/domain/result.ts';
import { ValidationError } from '@src/domain/value/error/validation-error.ts';

/**
 * Parse a required string field. Trims whitespace, rejects empty/whitespace-only.
 * Returns the trimmed value on success.
 */
export const parseRequiredString = (field: string, value: unknown): Result<string, ValidationError> => {
  if (typeof value !== 'string') {
    return Result.error(new ValidationError({ field, value, message: `${field} must be a string` }));
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return Result.error(new ValidationError({ field, value, message: `${field} must be a non-empty string` }));
  }
  return Result.ok(trimmed);
};
