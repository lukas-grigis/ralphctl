import { Result } from 'typescript-result';

import { ValidationError } from './validation-error.ts';

/**
 * `Slug` — lowercase alphanumeric + hyphens, 1..64 chars, no leading or
 * trailing hyphen. Reusable primitive composed by other value objects
 * (e.g. {@link ProjectName}, {@link SprintId}'s slug suffix).
 *
 * NOTE: Consecutive hyphens (`foo--bar`) are technically allowed by the
 * regex below. Documenting this as a deliberate looseness — adopt
 * existing data permits double hyphens. A future tightening could ban
 * them; do it lazily when a real input demonstrates the problem.
 */
declare const __slug: unique symbol;
export type Slug = string & { readonly [__slug]: 'Slug' };

const MAX_LENGTH = 64;
const SLUG_REGEX = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

function validate(input: unknown): Result<Slug, ValidationError> {
  if (typeof input !== 'string') {
    return Result.error(
      new ValidationError({
        field: 'slug',
        value: input,
        message: 'slug must be a string',
      })
    );
  }
  if (input.length === 0) {
    return Result.error(
      new ValidationError({
        field: 'slug',
        value: input,
        message: 'slug must not be empty',
        hint: 'use 1..64 lowercase alnum + hyphens',
      })
    );
  }
  if (input.length > MAX_LENGTH) {
    return Result.error(
      new ValidationError({
        field: 'slug',
        value: input,
        message: `slug must be at most ${String(MAX_LENGTH)} characters`,
      })
    );
  }
  if (!SLUG_REGEX.test(input)) {
    return Result.error(
      new ValidationError({
        field: 'slug',
        value: input,
        message: 'slug must be lowercase alphanumeric with hyphens, no leading/trailing hyphen',
        hint: 'matches /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/',
      })
    );
  }
  return Result.ok(input as Slug);
}

export const Slug = {
  /** Smart constructor — validates and brands. */
  parse(input: unknown): Result<Slug, ValidationError> {
    return validate(input);
  },
  /** Alias of `parse` for readability at call sites. */
  fromString(input: string): Result<Slug, ValidationError> {
    return validate(input);
  },
  /**
   * Internal escape hatch for already-validated strings (e.g. when reading
   * from JSON whose schema has already passed Zod validation).
   *
   * **Do not call from business code; persistence layer only.**
   */
  trustString(s: string): Slug {
    return s as Slug;
  },
};
