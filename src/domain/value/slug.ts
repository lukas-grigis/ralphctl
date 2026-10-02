import { Result } from '@src/domain/result.ts';
import { ValidationError } from '@src/domain/value/error/validation-error.ts';
import { toKebabCase } from '@src/domain/value/kebab-case.ts';

declare const __slug: unique symbol;
export type Slug = string & { readonly [__slug]: 'Slug' };

const MAX_LENGTH = 64;
const SLUG_REGEX = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

export const Slug = {
  parse(input: unknown): Result<Slug, ValidationError> {
    if (typeof input !== 'string') {
      return Result.error(new ValidationError({ field: 'slug', value: input, message: 'slug must be a string' }));
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
  },

  /** An explicit `candidate` wins; otherwise kebab-case `source` and parse it. */
  derive(field: string, candidate: Slug | undefined, source: string): Result<Slug, ValidationError> {
    if (candidate !== undefined) return Result.ok(candidate);
    const derived = toKebabCase(source);
    if (derived.length === 0) {
      return Result.error(
        new ValidationError({
          field,
          value: source,
          message: `could not derive slug from '${source}'`,
          hint: 'pass an explicit slug',
        })
      );
    }
    return Slug.parse(derived);
  },
};
