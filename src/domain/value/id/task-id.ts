import { Result } from '@src/domain/result.ts';
import { isUuidv7, uuidv7 } from '@src/domain/value/uuid7.ts';
import { ValidationError } from '@src/domain/value/error/validation-error.ts';

declare const __taskId: unique symbol;
export type TaskId = string & { readonly [__taskId]: 'TaskId' };

export const TaskId = {
  parse(input: unknown): Result<TaskId, ValidationError> {
    if (typeof input !== 'string') {
      return Result.error(new ValidationError({ field: 'task-id', value: input, message: 'task id must be a string' }));
    }
    if (!isUuidv7(input)) {
      return Result.error(
        new ValidationError({
          field: 'task-id',
          value: input,
          message: 'task id must be a UUIDv7',
          hint: 'matches /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/',
        })
      );
    }
    return Result.ok(input as TaskId);
  },
  generate(): TaskId {
    return uuidv7() as TaskId;
  },
};
