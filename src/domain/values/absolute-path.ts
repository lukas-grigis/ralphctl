import { isAbsolute } from 'node:path';
import { Result } from 'typescript-result';

import { ValidationError } from './validation-error.ts';

/**
 * `AbsolutePath` — a non-empty, fully-resolved filesystem path.
 *
 * Rules:
 *  - Must satisfy `path.isAbsolute()`.
 *  - Must not contain `~` (the caller is responsible for shell-style
 *    home-directory expansion).
 *  - Must not contain environment-variable syntax (`$FOO`, `${FOO}`).
 *  - Must not be empty / whitespace-only.
 *
 * **Filesystem existence is NOT checked here** — that is an integration
 * concern (an adapter touching the disk), not a domain invariant. A path
 * can be a valid `AbsolutePath` and point at a directory that hasn't been
 * created yet.
 */
declare const __absolutePath: unique symbol;
export type AbsolutePath = string & { readonly [__absolutePath]: 'AbsolutePath' };

// Matches `$FOO`, `$_BAR`, `${FOO}`, `${PATH:-default}`, etc.
const ENV_VAR_REGEX = /\$\{[^}]*\}|\$[A-Za-z_][A-Za-z0-9_]*/;

function validate(input: unknown): Result<AbsolutePath, ValidationError> {
  if (typeof input !== 'string') {
    return Result.error(
      new ValidationError({
        field: 'absolute-path',
        value: input,
        message: 'absolute path must be a string',
      })
    );
  }
  if (input.trim().length === 0) {
    return Result.error(
      new ValidationError({
        field: 'absolute-path',
        value: input,
        message: 'absolute path must not be empty or whitespace-only',
      })
    );
  }
  if (input.includes('~')) {
    return Result.error(
      new ValidationError({
        field: 'absolute-path',
        value: input,
        message: 'absolute path must not contain "~"',
        hint: 'expand the home directory before constructing an AbsolutePath',
      })
    );
  }
  if (ENV_VAR_REGEX.test(input)) {
    return Result.error(
      new ValidationError({
        field: 'absolute-path',
        value: input,
        message: 'absolute path must not contain environment variable references',
        hint: 'expand $VAR / ${VAR} via process.env before constructing an AbsolutePath',
      })
    );
  }
  if (!isAbsolute(input)) {
    return Result.error(
      new ValidationError({
        field: 'absolute-path',
        value: input,
        message: 'path must be absolute',
        hint: 'use path.resolve() to convert a relative path before construction',
      })
    );
  }
  return Result.ok(input as AbsolutePath);
}

export const AbsolutePath = {
  parse(input: unknown): Result<AbsolutePath, ValidationError> {
    return validate(input);
  },
  /**
   * Internal escape hatch for already-validated strings (e.g. paths read
   * from persisted JSON that has already passed schema validation).
   *
   * **Do not call from business code; persistence layer only.**
   */
  trustString(s: string): AbsolutePath {
    return s as AbsolutePath;
  },
};
