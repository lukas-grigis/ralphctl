import { isAbsolute } from 'node:path';
import { Result } from '@src/domain/result.ts';
import { ValidationError } from '@src/domain/value/error/validation-error.ts';

declare const __absolutePath: unique symbol;
export type AbsolutePath = string & { readonly [__absolutePath]: 'AbsolutePath' };

const ENV_VAR_REGEX = /\$\{[^}]*\}|\$[A-Za-z_][A-Za-z0-9_]*/;

/** `ValidationError.field` value shared by every failure branch of {@link AbsolutePath.parse}. */
const ABSOLUTE_PATH_FIELD = 'absolute-path';

export const AbsolutePath = {
  parse(input: unknown): Result<AbsolutePath, ValidationError> {
    if (typeof input !== 'string') {
      return Result.error(
        new ValidationError({
          field: ABSOLUTE_PATH_FIELD,
          value: input,
          message: 'absolute path must be a string',
        })
      );
    }
    if (input.trim().length === 0) {
      return Result.error(
        new ValidationError({
          field: ABSOLUTE_PATH_FIELD,
          value: input,
          message: 'absolute path must not be empty or whitespace-only',
        })
      );
    }
    if (input.includes('~')) {
      return Result.error(
        new ValidationError({
          field: ABSOLUTE_PATH_FIELD,
          value: input,
          message: 'absolute path must not contain "~"',
          hint: 'expand the home directory before constructing an AbsolutePath',
        })
      );
    }
    if (ENV_VAR_REGEX.test(input)) {
      return Result.error(
        new ValidationError({
          field: ABSOLUTE_PATH_FIELD,
          value: input,
          message: 'absolute path must not contain environment variable references',
          hint: 'expand $VAR / ${VAR} via process.env before constructing an AbsolutePath',
        })
      );
    }
    if (!isAbsolute(input)) {
      return Result.error(
        new ValidationError({
          field: ABSOLUTE_PATH_FIELD,
          value: input,
          message: 'path must be absolute',
          hint: 'use path.resolve() to convert a relative path before construction',
        })
      );
    }
    return Result.ok(input as AbsolutePath);
  },
};
