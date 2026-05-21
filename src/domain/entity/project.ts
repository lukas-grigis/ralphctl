import { Result } from '@src/domain/result.ts';
import type { Entity } from '@src/domain/entity/_base/entity.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { ProjectId } from '@src/domain/value/id/project-id.ts';
import type { RepositoryId } from '@src/domain/value/id/repository-id.ts';
import { Slug } from '@src/domain/value/slug.ts';
import { toKebabCase } from '@src/domain/value/kebab-case.ts';
import { parseOptionalString } from '@src/domain/value/parsers/parse-optional-string.ts';
import { parseRequiredString } from '@src/domain/value/parsers/parse-required-string.ts';
import { ConflictError } from '@src/domain/value/error/conflict-error.ts';
import { ValidationError } from '@src/domain/value/error/validation-error.ts';
import {
  type Repository,
  setRepositoryVerifyScript,
  setRepositoryVerifyTimeout,
  setRepositoryName,
  setRepositoryPath,
  setRepositorySetupScript,
  setRepositorySetupSkill,
  setRepositorySlug,
  setRepositoryVerifySkill,
} from '@src/domain/entity/repository.ts';

/**
 * Where ralphctl should create new issues when a refined ticket has no `link` and the user
 * picks "Approve & create origin" in the refine flow. `provider` selects gh vs glab; `owner`
 * and `repo` are the slugs the CLI expects (`gh issue create --repo <owner>/<repo>`).
 */
export interface IssueOriginRef {
  readonly provider: 'github' | 'gitlab';
  readonly owner: string;
  readonly repo: string;
}

export interface Project extends Entity<ProjectId> {
  /** Globally-unique kebab-case handle for CLI lookups. Renamable without breaking refs. */
  readonly slug: Slug;
  readonly displayName: string;
  readonly description?: string;
  readonly repositories: readonly Repository[];
  /**
   * Default issue tracker the refine flow targets when a ticket has no `link`. Optional —
   * when unset, the refine flow's "create origin" option is hidden and only the
   * "update existing origin" path is offered (and only when the ticket itself has a link).
   */
  readonly defaultIssueOrigin?: IssueOriginRef;
}

export interface ProjectCreateInput {
  readonly id?: ProjectId;
  readonly displayName: string;
  /** Optional. Defaults to `kebab-case(displayName)` when omitted. */
  readonly slug?: Slug;
  readonly description?: string;
  readonly repositories: readonly Repository[];
  readonly defaultIssueOrigin?: IssueOriginRef;
}

/** Subset of `Repository` fields editable via {@link updateRepository}. */
export type RepositoryUpdate = Partial<
  Pick<
    Repository,
    'name' | 'slug' | 'path' | 'verifyScript' | 'verifyTimeout' | 'setupScript' | 'setupSkill' | 'verifySkill'
  >
> & {
  /** Path is an `AbsolutePath` value object — re-typed here for clarity. */
  readonly path?: AbsolutePath;
};

/**
 * Aggregate invariants enforced by {@link createProject}:
 *  - non-empty `displayName` (trimmed)
 *  - at least one repository
 *  - unique repository ids
 *  - unique repository slugs (within the project)
 */
export const createProject = (input: ProjectCreateInput): Result<Project, ValidationError> => {
  const displayName = parseRequiredString('project.displayName', input.displayName);
  if (!displayName.ok) return Result.error(displayName.error);

  const description = parseOptionalString('project.description', input.description);
  if (!description.ok) return Result.error(description.error);

  const slug = resolveSlug('project.slug', input.slug, displayName.value);
  if (!slug.ok) return Result.error(slug.error);

  if (input.repositories.length === 0) {
    return Result.error(
      new ValidationError({
        field: 'project.repositories',
        value: input.repositories,
        message: 'project must have at least one repository',
      })
    );
  }

  const seenIds = new Set<RepositoryId>();
  const seenSlugs = new Set<Slug>();
  for (const repo of input.repositories) {
    if (seenIds.has(repo.id)) {
      return Result.error(
        new ValidationError({
          field: 'project.repositories',
          value: repo.id,
          message: `duplicate repository id '${repo.id}' (slug '${repo.slug}', name '${repo.name}')`,
        })
      );
    }
    if (seenSlugs.has(repo.slug)) {
      return Result.error(
        new ValidationError({
          field: 'project.repositories',
          value: repo.slug,
          message: `duplicate repository slug '${repo.slug}' (id '${repo.id}', name '${repo.name}')`,
        })
      );
    }
    seenIds.add(repo.id);
    seenSlugs.add(repo.slug);
  }

  return Result.ok({
    id: input.id ?? ProjectId.generate(),
    slug: slug.value,
    displayName: displayName.value,
    ...(description.value !== undefined ? { description: description.value } : {}),
    repositories: [...input.repositories],
    ...(input.defaultIssueOrigin !== undefined ? { defaultIssueOrigin: input.defaultIssueOrigin } : {}),
  });
};

export const addRepository = (project: Project, repo: Repository): Result<Project, ConflictError> => {
  if (project.repositories.some((r) => r.id === repo.id)) {
    return Result.error(
      new ConflictError({
        entity: 'repository',
        field: 'id',
        value: repo.id,
        hint: 'A repository with this id is already registered on the project.',
      })
    );
  }
  if (project.repositories.some((r) => r.slug === repo.slug)) {
    return Result.error(
      new ConflictError({
        entity: 'repository',
        field: 'slug',
        value: repo.slug,
        hint: 'A repository with this slug is already registered on the project.',
      })
    );
  }
  return Result.ok({ ...project, repositories: [...project.repositories, repo] });
};

export const removeRepository = (project: Project, id: RepositoryId): Result<Project, ValidationError> => {
  if (project.repositories.length <= 1) {
    return Result.error(
      new ValidationError({
        field: 'project.repositories',
        value: id,
        message: 'project must keep at least one repository — refusing to remove the last one',
      })
    );
  }
  const next = project.repositories.filter((r) => r.id !== id);
  if (next.length === project.repositories.length) {
    return Result.error(
      new ValidationError({
        field: 'project.repositories',
        value: id,
        message: `repository '${id}' not found on project '${project.slug}'`,
      })
    );
  }
  return Result.ok({ ...project, repositories: next });
};

/**
 * Rename a project's human-readable label. Free-form trimmed string. Does not touch `slug` —
 * slug renames go via {@link setProjectSlug} so the operator can fix typos on `displayName`
 * without losing the existing CLI handle.
 */
export const setProjectDisplayName = (project: Project, name: string): Result<Project, ValidationError> => {
  const parsed = parseRequiredString('project.displayName', name);
  if (!parsed.ok) return Result.error(parsed.error);
  return Result.ok({ ...project, displayName: parsed.value });
};

/**
 * Rename the project's CLI handle. Caller is responsible for uniqueness across the
 * project repository — this helper is a pure setter; the persistence layer rejects collisions.
 */
export const setProjectSlug = (project: Project, slug: Slug): Project => ({
  ...project,
  slug,
});

export const updateRepository = (
  project: Project,
  id: RepositoryId,
  partial: RepositoryUpdate
): Result<Project, ValidationError | ConflictError> => {
  const idx = project.repositories.findIndex((r) => r.id === id);
  if (idx === -1) {
    return Result.error(
      new ValidationError({
        field: 'project.repositories',
        value: id,
        message: `repository '${id}' not found on project '${project.slug}'`,
      })
    );
  }

  const target = project.repositories[idx];
  if (target === undefined) {
    return Result.error(
      new ValidationError({
        field: 'project.repositories',
        value: id,
        message: `repository '${id}' lookup returned undefined`,
      })
    );
  }

  let updated: Repository = target;
  if (partial.name !== undefined) {
    const r = setRepositoryName(updated, partial.name);
    if (!r.ok) return Result.error(r.error);
    updated = r.value;
  }
  if (partial.slug !== undefined) {
    if (project.repositories.some((r) => r.id !== id && r.slug === partial.slug)) {
      return Result.error(
        new ConflictError({
          entity: 'repository',
          field: 'slug',
          value: partial.slug,
          hint: 'Another repository on this project already uses this slug.',
        })
      );
    }
    updated = setRepositorySlug(updated, partial.slug);
  }
  if (partial.path !== undefined) {
    updated = setRepositoryPath(updated, partial.path);
  }
  if ('verifyScript' in partial) {
    const r = setRepositoryVerifyScript(updated, partial.verifyScript);
    if (!r.ok) return Result.error(r.error);
    updated = r.value;
  }
  if ('verifyTimeout' in partial) {
    const r = setRepositoryVerifyTimeout(updated, partial.verifyTimeout);
    if (!r.ok) return Result.error(r.error);
    updated = r.value;
  }
  if ('setupScript' in partial) {
    const r = setRepositorySetupScript(updated, partial.setupScript);
    if (!r.ok) return Result.error(r.error);
    updated = r.value;
  }
  if ('setupSkill' in partial) {
    const r = setRepositorySetupSkill(updated, partial.setupSkill);
    if (!r.ok) return Result.error(r.error);
    updated = r.value;
  }
  if ('verifySkill' in partial) {
    const r = setRepositoryVerifySkill(updated, partial.verifySkill);
    if (!r.ok) return Result.error(r.error);
    updated = r.value;
  }

  const next = [...project.repositories];
  next[idx] = updated;
  return Result.ok({ ...project, repositories: next });
};

const resolveSlug = (
  field: string,
  candidate: Slug | undefined,
  fallbackSource: string
): Result<Slug, ValidationError> => {
  if (candidate !== undefined) return Result.ok(candidate);
  const derived = toKebabCase(fallbackSource);
  if (derived.length === 0) {
    return Result.error(
      new ValidationError({
        field,
        value: fallbackSource,
        message: `could not derive slug from '${fallbackSource}'`,
        hint: 'pass an explicit slug',
      })
    );
  }
  return Slug.parse(derived);
};
