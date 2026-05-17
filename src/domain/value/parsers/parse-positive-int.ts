import { Result } from '@src/domain/result.ts';
import { ValidationError } from '@src/domain/value/error/validation-error.ts';

/** Parse a positive integer. Rejects non-finite, non-integer, zero, and negative values. */
export const parsePositiveInt = (field: string, value: unknown): Result<number, ValidationError> => {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    return Result.error(new ValidationError({ field, value, message: `${field} must be a positive integer` }));
  }
  return Result.ok(value);
};
