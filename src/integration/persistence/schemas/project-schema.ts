import { z } from 'zod';

import { Project } from '../../../domain/entities/project.ts';
import { Repository } from '../../../domain/entities/repository.ts';
import { StorageError } from '../../../domain/errors/storage-error.ts';
import { Result } from '../../../domain/result.ts';
import { AbsolutePath } from '../../../domain/values/absolute-path.ts';
import { IsoTimestamp } from '../../../domain/values/iso-timestamp.ts';
import { ProjectName } from '../../../domain/values/project-name.ts';

const repositoryJsonSchema = z.object({
  name: z.string(),
  path: z.string(),
  checkScript: z.string().optional(),
  checkTimeout: z.number().int().positive().optional(),
  setupScript: z.string().optional(),
  onboardedAt: z.string().optional(),
});

export type RepositoryJson = z.infer<typeof repositoryJsonSchema>;

/** On-disk shape of a single project. */
export const projectJsonSchema = z.object({
  name: z.string(),
  displayName: z.string(),
  description: z.string().optional(),
  repositories: z.array(repositoryJsonSchema),
});

export type ProjectJson = z.infer<typeof projectJsonSchema>;

/**
 * `projects.json` holds every registered project as a single envelope so the
 * file is a single read/write under one lock. Schema is versioned with the
 * `version` field so future migrations can branch on it.
 */
export const projectsFileSchema = z.object({
  version: z.literal(1),
  projects: z.array(projectJsonSchema),
});

export type ProjectsFile = z.infer<typeof projectsFileSchema>;

/** Empty starter envelope — used when projects.json doesn't exist yet. */
export function emptyProjectsFile(): ProjectsFile {
  return { version: 1, projects: [] };
}

/**
 * Convert a parsed `ProjectJson` to a `Project` aggregate. Uses
 * {@link AbsolutePath.trustString} / {@link ProjectName.trustString} —
 * the JSON has already passed schema validation in `json-io`.
 */
export function toProject(parsed: ProjectJson): Result<Project, StorageError> {
  const repos: Repository[] = [];
  for (const repoJson of parsed.repositories) {
    const r = Repository.create({
      path: AbsolutePath.trustString(repoJson.path),
      name: repoJson.name,
      ...(repoJson.checkScript !== undefined ? { checkScript: repoJson.checkScript } : {}),
      ...(repoJson.checkTimeout !== undefined ? { checkTimeout: repoJson.checkTimeout } : {}),
      ...(repoJson.setupScript !== undefined ? { setupScript: repoJson.setupScript } : {}),
      ...(repoJson.onboardedAt !== undefined ? { onboardedAt: IsoTimestamp.trustString(repoJson.onboardedAt) } : {}),
    });
    if (!r.ok) {
      return Result.error(
        new StorageError({
          subCode: 'schema-mismatch',
          message: `repository '${repoJson.path}' on project '${parsed.name}' failed entity validation: ${r.error.message}`,
          cause: r.error,
        })
      );
    }
    repos.push(r.value);
  }

  const created = Project.create({
    name: ProjectName.trustString(parsed.name),
    displayName: parsed.displayName,
    ...(parsed.description !== undefined ? { description: parsed.description } : {}),
    repositories: repos,
  });
  if (!created.ok) {
    return Result.error(
      new StorageError({
        subCode: 'schema-mismatch',
        message: `project '${parsed.name}' failed entity validation: ${created.error.message}`,
        cause: created.error,
      })
    );
  }
  return Result.ok(created.value);
}

/** Reverse direction — Project entity → JSON-shaped object. */
export function fromProject(project: Project): ProjectJson {
  return {
    name: project.name,
    displayName: project.displayName,
    ...(project.description !== undefined ? { description: project.description } : {}),
    repositories: project.repositories.map((r) => ({
      name: r.name,
      path: r.path,
      ...(r.checkScript !== undefined ? { checkScript: r.checkScript } : {}),
      ...(r.checkTimeout !== undefined ? { checkTimeout: r.checkTimeout } : {}),
      ...(r.setupScript !== undefined ? { setupScript: r.setupScript } : {}),
      ...(r.onboardedAt !== null ? { onboardedAt: r.onboardedAt } : {}),
    })),
  };
}
