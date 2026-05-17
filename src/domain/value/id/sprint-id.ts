import { Result } from '@src/domain/result.ts';
import { isUuidv7, uuidv7 } from '@src/domain/value/uuid7.ts';
import { ValidationError } from '@src/domain/value/error/validation-error.ts';

declare const __sprintId: unique symbol;
export type SprintId = string & { readonly [__sprintId]: 'SprintId' };

export const SprintId = {
  parse(input: unknown): Result<SprintId, ValidationError> {
    if (typeof input !== 'string') {
      return Result.error(
        new ValidationError({ field: 'sprint-id', value: input, message: 'sprint id must be a string' })
      );
    }
    if (!isUuidv7(input)) {
      return Result.error(
        new ValidationError({
          field: 'sprint-id',
          value: input,
          message: 'sprint id must be a UUIDv7',
          hint: 'matches /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/',
        })
      );
    }
    return Result.ok(input as SprintId);
  },
  generate(): SprintId {
    return uuidv7() as SprintId;
  },
};
