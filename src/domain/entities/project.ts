import { Result } from 'typescript-result';

import { ConflictError } from '@src/domain/errors/conflict-error.ts';
import type { AbsolutePath } from '@src/domain/values/absolute-path.ts';
import type { IsoTimestamp } from '@src/domain/values/iso-timestamp.ts';
import type { ProjectName } from '@src/domain/values/project-name.ts';
import { ValidationError } from '@src/domain/values/validation-error.ts';
import { Repository } from './repository.ts';

/** Construction inputs for {@link Project.create}. */
export interface ProjectCreateInput {
  readonly name: ProjectName;
  readonly displayName: string;
  readonly description?: string;
  readonly repositories: readonly Repository[];
}

/** Subset of {@link Repository} fields that can be updated in-place. */
export type RepositoryUpdate = Partial<
  Pick<Repository, 'name' | 'checkScript' | 'checkTimeout' | 'setupScript'> & {
    /** Set/clear the onboarded marker. Pass `null` to clear. */
    readonly onboardedAt: IsoTimestamp | null;
  }
>;

/**
 * `Project` — aggregate root containing one or more `Repository`s. The
 * project must always have at least one repository; removing the last one
 * fails with a `ValidationError` so the invariant cannot drift.
 *
 * Repositories are uniquely identified by their absolute path. Adding a
 * repository whose path is already present fails with a `ConflictError`.
 */
export class Project {
  readonly name: ProjectName;
  readonly displayName: string;
  readonly description: string | undefined;
  readonly repositories: readonly Repository[];

  private constructor(props: {
    name: ProjectName;
    displayName: string;
    description: string | undefined;
    repositories: readonly Repository[];
  }) {
    this.name = props.name;
    this.displayName = props.displayName;
    this.description = props.description;
    this.repositories = props.repositories;
  }

  static create(input: ProjectCreateInput): Result<Project, ValidationError> {
    const displayName = input.displayName.trim();
    if (displayName.length === 0) {
      return Result.error(
        new ValidationError({
          field: 'project.displayName',
          value: input.displayName,
          message: 'project displayName must be a non-empty string',
        })
      );
    }

    if (input.repositories.length === 0) {
      return Result.error(
        new ValidationError({
          field: 'project.repositories',
          value: input.repositories,
          message: 'project must have at least one repository',
        })
      );
    }

    // Detect duplicate paths up front — the aggregate invariant.
    const seen = new Set<AbsolutePath>();
    for (const repo of input.repositories) {
      if (seen.has(repo.path)) {
        return Result.error(
          new ValidationError({
            field: 'project.repositories',
            value: repo.path,
            message: `duplicate repository path '${repo.path}'`,
          })
        );
      }
      seen.add(repo.path);
    }

    const description = input.description?.trim();

    return Result.ok(
      new Project({
        name: input.name,
        displayName,
        description: description !== undefined && description.length > 0 ? description : undefined,
        repositories: [...input.repositories],
      })
    );
  }

  addRepository(repo: Repository): Result<Project, ConflictError> {
    if (this.repositories.some((r) => r.path === repo.path)) {
      return Result.error(
        new ConflictError({
          entity: 'repository',
          conflictingId: repo.path,
          hint: 'This repository path is already registered on the project.',
        })
      );
    }
    return Result.ok(
      new Project({
        name: this.name,
        displayName: this.displayName,
        description: this.description,
        repositories: [...this.repositories, repo],
      })
    );
  }

  removeRepository(path: AbsolutePath): Result<Project, ValidationError> {
    if (this.repositories.length <= 1) {
      return Result.error(
        new ValidationError({
          field: 'project.repositories',
          value: path,
          message: 'project must keep at least one repository — refusing to remove the last one',
        })
      );
    }
    const next = this.repositories.filter((r) => r.path !== path);
    if (next.length === this.repositories.length) {
      return Result.error(
        new ValidationError({
          field: 'project.repositories',
          value: path,
          message: `repository '${path}' not found on project '${this.name}'`,
        })
      );
    }
    return Result.ok(
      new Project({
        name: this.name,
        displayName: this.displayName,
        description: this.description,
        repositories: next,
      })
    );
  }

  updateRepository(path: AbsolutePath, partial: RepositoryUpdate): Result<Project, ValidationError> {
    const idx = this.repositories.findIndex((r) => r.path === path);
    if (idx === -1) {
      return Result.error(
        new ValidationError({
          field: 'project.repositories',
          value: path,
          message: `repository '${path}' not found on project '${this.name}'`,
        })
      );
    }

    const target = this.repositories[idx];
    // Defensive — index was just checked.
    if (target === undefined) {
      return Result.error(
        new ValidationError({
          field: 'project.repositories',
          value: path,
          message: `repository '${path}' lookup returned undefined`,
        })
      );
    }

    let updated = target;
    if ('checkScript' in partial) {
      const r = updated.withCheckScript(partial.checkScript);
      if (!r.ok) return Result.error(r.error);
      updated = r.value;
    }
    if ('checkTimeout' in partial) {
      const r = updated.withCheckTimeout(partial.checkTimeout);
      if (!r.ok) return Result.error(r.error);
      updated = r.value;
    }
    if ('setupScript' in partial) {
      const r = updated.withSetupScript(partial.setupScript);
      if (!r.ok) return Result.error(r.error);
      updated = r.value;
    }
    if ('onboardedAt' in partial && partial.onboardedAt !== undefined) {
      // null → clear; IsoTimestamp → mark.
      updated = partial.onboardedAt === null ? updated.clearOnboarded() : updated.markOnboarded(partial.onboardedAt);
    }
    if ('name' in partial && partial.name !== undefined) {
      const recreated = Repository.create({
        path: updated.path,
        name: partial.name,
        checkScript: updated.checkScript,
        checkTimeout: updated.checkTimeout,
        ...(updated.setupScript !== undefined ? { setupScript: updated.setupScript } : {}),
        ...(updated.onboardedAt !== null ? { onboardedAt: updated.onboardedAt } : {}),
      });
      if (!recreated.ok) return Result.error(recreated.error);
      updated = recreated.value;
    }

    const next = [...this.repositories];
    next[idx] = updated;
    return Result.ok(
      new Project({
        name: this.name,
        displayName: this.displayName,
        description: this.description,
        repositories: next,
      })
    );
  }
}
