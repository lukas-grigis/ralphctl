import { Result } from '@src/domain/result.ts';
import { ValidationError } from '@src/domain/value/error/validation-error.ts';

declare const __commitSha: unique symbol;
export type CommitSha = string & { readonly [__commitSha]: 'CommitSha' };

const COMMIT_SHA_REGEX = /^[0-9a-f]{40}$/;

export const CommitSha = {
  parse(input: unknown): Result<CommitSha, ValidationError> {
    if (typeof input !== 'string') {
      return Result.error(
        new ValidationError({ field: 'commit-sha', value: input, message: 'commit sha must be a string' })
      );
    }
    if (!COMMIT_SHA_REGEX.test(input)) {
      return Result.error(
        new ValidationError({
          field: 'commit-sha',
          value: input,
          message: 'commit sha must be 40 lowercase hex characters',
          hint: 'pass the full sha; pre-lowercase upstream',
        })
      );
    }
    return Result.ok(input as CommitSha);
  },
};
