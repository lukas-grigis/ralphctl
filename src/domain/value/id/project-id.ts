import { Result } from '@src/domain/result.ts';
import { isUuidv7, uuidv7 } from '@src/domain/value/uuid7.ts';
import { ValidationError } from '@src/domain/value/error/validation-error.ts';

declare const __projectId: unique symbol;
export type ProjectId = string & { readonly [__projectId]: 'ProjectId' };

export const ProjectId = {
  parse(input: unknown): Result<ProjectId, ValidationError> {
    if (typeof input !== 'string') {
      return Result.error(
        new ValidationError({ field: 'project-id', value: input, message: 'project id must be a string' })
      );
    }
    if (!isUuidv7(input)) {
      return Result.error(
        new ValidationError({
          field: 'project-id',
          value: input,
          message: 'project id must be a UUIDv7',
          hint: 'matches /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/',
        })
      );
    }
    return Result.ok(input as ProjectId);
  },
  generate(): ProjectId {
    return uuidv7() as ProjectId;
  },
};
