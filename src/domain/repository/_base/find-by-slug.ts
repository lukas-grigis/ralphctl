/**
 * CLI-friendly look-up by slug. Every aggregate in this codebase has a kebab-case slug that
 * the CLI accepts in place of the UUID (e.g. `ralphctl sprint show <slug>`).
 *
 * `Scope` is the optional "where to look" parameter: `void` for globally-unique slugs (e.g.
 * `Project.slug`), or a parent-id type for slugs that are only unique within a parent (e.g.
 * `Sprint.slug` is unique only within its `ProjectId`).
 */

import type { Result } from '@src/domain/result.ts';
import type { Entity } from '@src/domain/entity/_base/entity.ts';
import type { Slug } from '@src/domain/value/slug.ts';
import type { NotFoundError } from '@src/domain/value/error/not-found-error.ts';
import type { StorageError } from '@src/domain/value/error/storage-error.ts';

export interface FindBySlug<E extends Entity<unknown>, Scope = void> {
  findBySlug(
    slug: Slug,
    ...args: Scope extends void ? [] : [scope: Scope]
  ): Promise<Result<E, NotFoundError | StorageError>>;
}
