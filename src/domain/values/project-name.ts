import { Result } from 'typescript-result';

import { Slug } from './slug.ts';
import { ValidationError } from './validation-error.ts';

/**
 * `ProjectName` — the slug-shaped identifier of a registered project.
 *
 * Shares the `Slug` regex (lowercase alnum + hyphens, 1..64 chars), but
 * carries its own brand. A `Slug` cannot be passed where a `ProjectName`
 * is expected and vice versa — the type system distinguishes a generic
 * slug primitive from a domain-meaningful identifier so call sites can't
 * accidentally swap "ticket slug" with "project name".
 *
 * Implementation delegates to `Slug.parse` and re-brands. The runtime
 * predicate is identical; the type-level distinction is the point.
 */
declare const __projectName: unique symbol;
export type ProjectName = string & { readonly [__projectName]: 'ProjectName' };

function validate(input: unknown): Result<ProjectName, ValidationError> {
  const slugResult = Slug.parse(input);
  if (!slugResult.ok) {
    // Re-emit with the more specific field name for cleaner diagnostics.
    return Result.error(
      new ValidationError({
        field: 'project-name',
        value: input,
        message: slugResult.error.message,
        ...(slugResult.error.hint !== undefined ? { hint: slugResult.error.hint } : {}),
      })
    );
  }
  return Result.ok(slugResult.value as unknown as ProjectName);
}

export const ProjectName = {
  parse(input: unknown): Result<ProjectName, ValidationError> {
    return validate(input);
  },
  /**
   * Internal escape hatch for already-validated strings (e.g. read from
   * persisted JSON that has already passed schema validation).
   *
   * **Do not call from business code; persistence layer only.**
   */
  trustString(s: string): ProjectName {
    return s as ProjectName;
  },
};
