import { basename, resolve } from 'node:path';
import { expandTilde, getProjectsFilePath, validateProjectPath } from '@src/integration/persistence/paths.ts';
import { fileExists, readValidatedJson, writeValidatedJson } from '@src/integration/persistence/storage.ts';
import { type Project, type Projects, ProjectsSchema, type Repository } from '@src/domain/models.ts';
import { generateUuid8 } from '@src/domain/ids.ts';
import { ParseError, ProjectExistsError, ProjectNotFoundError, ValidationError } from '@src/domain/errors.ts';

export { ProjectNotFoundError, ProjectExistsError } from '@src/domain/errors.ts';

/**
 * Migration: legacy data formats → current schema.
 * Handles two historical shapes:
 *   1. Oldest: `paths: string[]` (pre-Repository).
 *   2. Older: Repository / Project without `id` fields.
 * Both get normalised to the current schema by generating fresh UUID8 ids.
 */
interface LegacyProject {
  id?: string;
  name: string;
  displayName: string;
  paths?: string[];
  repositories?: (
    | Repository
    | { name: string; path: string; checkScript?: string; checkTimeout?: number; id?: string }
  )[];
  description?: string;
}

function migrateProjectIfNeeded(project: LegacyProject): Project {
  const id = project.id ?? generateUuid8();

  // Oldest format: paths[] string array
  if (project.paths && !project.repositories) {
    return {
      id,
      name: project.name,
      displayName: project.displayName,
      repositories: project.paths.map((p) => ({
        id: generateUuid8(),
        name: basename(p),
        path: resolve(expandTilde(p)),
      })),
      description: project.description,
    };
  }

  if (project.repositories) {
    return {
      id,
      name: project.name,
      displayName: project.displayName,
      repositories: project.repositories.map((r) => ({
        id: r.id ?? generateUuid8(),
        name: r.name,
        path: r.path,
        checkScript: r.checkScript,
        checkTimeout: r.checkTimeout,
      })),
      description: project.description,
    };
  }

  throw new ParseError(`Invalid project data: no paths or repositories for ${project.name}`);
}

/**
 * Get all projects. Transparently migrates legacy files by stamping missing
 * `id` fields on projects and repositories before validating.
 */
export async function listProjects(): Promise<Projects> {
  const filePath = getProjectsFilePath();
  if (!(await fileExists(filePath))) {
    return [];
  }

  const { readFile } = await import('node:fs/promises');
  const content = await readFile(filePath, 'utf-8');
  const rawData = JSON.parse(content) as LegacyProject[];

  const needsMigration = rawData.some((p) => {
    if (!p.id) return true;
    if (p.paths && !p.repositories) return true;
    return (p.repositories ?? []).some((r) => !r.id);
  });

  if (needsMigration) {
    const migrated = rawData.map(migrateProjectIfNeeded);
    const validated = ProjectsSchema.parse(migrated);
    const writeResult = await writeValidatedJson(filePath, validated, ProjectsSchema);
    if (!writeResult.ok) throw writeResult.error;
    return validated;
  }

  const result = await readValidatedJson(filePath, ProjectsSchema);
  if (!result.ok) throw result.error;
  const projects = result.value;

  // One-time cleanup: correct any tilde paths stored before write-time expansion
  // was added. Safe to remove once existing users have been migrated.
  const hasTildePaths = projects.some((p) => p.repositories.some((r) => r.path.startsWith('~')));

  if (hasTildePaths) {
    const corrected = projects.map((project) => ({
      ...project,
      repositories: project.repositories.map((repo) =>
        repo.path.startsWith('~') ? { ...repo, path: resolve(expandTilde(repo.path)) } : repo
      ),
    }));
    const validated = ProjectsSchema.parse(corrected);
    const writeResult = await writeValidatedJson(filePath, validated, ProjectsSchema);
    if (!writeResult.ok) throw writeResult.error;
    return validated;
  }

  return projects;
}

/** Throws `ProjectNotFoundError` when no project has the given slug. */
export async function getProject(name: string): Promise<Project> {
  const projects = await listProjects();
  const project = projects.find((p) => p.name === name);
  if (!project) {
    throw new ProjectNotFoundError(name);
  }
  return project;
}

/** Throws `ProjectNotFoundError` when no project has the given id. */
export async function getProjectById(id: string): Promise<Project> {
  const projects = await listProjects();
  const project = projects.find((p) => p.id === id);
  if (!project) {
    throw new ProjectNotFoundError(id);
  }
  return project;
}

/**
 * Locate a repository by id across every project. Returns the owning project
 * alongside the repo so callers can derive the check script / scope.
 * Throws `ValidationError` when no repo matches — every repoId stored in a
 * ticket or task should resolve.
 */
export async function getRepoById(repoId: string): Promise<{ project: Project; repo: Repository }> {
  const projects = await listProjects();
  for (const project of projects) {
    const repo = project.repositories.find((r) => r.id === repoId);
    if (repo) return { project, repo };
  }
  throw new ValidationError(`Repository not found: ${repoId}`, 'repoId');
}

/** Absolute filesystem path for a repoId — convenience over `getRepoById`. */
export async function resolveRepoPath(repoId: string): Promise<string> {
  const { repo } = await getRepoById(repoId);
  return repo.path;
}

export async function projectExists(name: string): Promise<boolean> {
  const projects = await listProjects();
  return projects.some((p) => p.name === name);
}

export interface CreateProjectInput {
  /** Omit to have one generated. */
  readonly id?: string;
  readonly name: string;
  readonly displayName: string;
  readonly repositories: readonly (Omit<Repository, 'id' | 'name'> & { id?: string; name?: string })[];
  readonly description?: string;
}

/**
 * Create a new project. Generates ids for the project and every repo that
 * doesn't already carry one. Resolves paths and validates each points at an
 * existing directory.
 */
export async function createProject(input: CreateProjectInput): Promise<Project> {
  const projects = await listProjects();

  if (projects.some((p) => p.name === input.name)) {
    throw new ProjectExistsError(input.name);
  }

  const pathErrors: string[] = [];
  for (const repo of input.repositories) {
    const resolved = resolve(expandTilde(repo.path));
    const validation = await validateProjectPath(resolved);
    if (!validation.ok) {
      pathErrors.push(`  ${repo.path}: ${validation.error.message}`);
    }
  }
  if (pathErrors.length > 0) {
    throw new ValidationError(`Invalid project paths:\n${pathErrors.join('\n')}`, 'repositories');
  }

  const normalizedProject: Project = {
    id: input.id ?? generateUuid8(),
    name: input.name,
    displayName: input.displayName,
    description: input.description,
    repositories: input.repositories.map((repo) => {
      const resolvedPath = resolve(expandTilde(repo.path));
      return {
        id: repo.id ?? generateUuid8(),
        name: repo.name && repo.name.length > 0 ? repo.name : basename(resolvedPath),
        path: resolvedPath,
        checkScript: repo.checkScript,
        checkTimeout: repo.checkTimeout,
      };
    }),
  };

  projects.push(normalizedProject);
  const writeResult = await writeValidatedJson(getProjectsFilePath(), projects, ProjectsSchema);
  if (!writeResult.ok) throw writeResult.error;

  return normalizedProject;
}

/** Update by slug. `id` and `name` are immutable. */
export async function updateProject(name: string, updates: Partial<Omit<Project, 'name' | 'id'>>): Promise<Project> {
  const projects = await listProjects();
  const index = projects.findIndex((p) => p.name === name);

  if (index === -1) {
    throw new ProjectNotFoundError(name);
  }

  if (updates.repositories) {
    const pathErrors: string[] = [];
    for (const repo of updates.repositories) {
      const resolved = resolve(expandTilde(repo.path));
      const validation = await validateProjectPath(resolved);
      if (!validation.ok) {
        pathErrors.push(`  ${repo.path}: ${validation.error.message}`);
      }
    }
    if (pathErrors.length > 0) {
      throw new ValidationError(`Invalid project paths:\n${pathErrors.join('\n')}`, 'repositories');
    }
    updates.repositories = updates.repositories.map((repo) => ({
      id: repo.id.length > 0 ? repo.id : generateUuid8(),
      name: repo.name && repo.name.length > 0 ? repo.name : basename(resolve(expandTilde(repo.path))),
      path: resolve(expandTilde(repo.path)),
      checkScript: repo.checkScript,
      checkTimeout: repo.checkTimeout,
    }));
  }

  const existingProject = projects[index];
  if (!existingProject) {
    throw new ProjectNotFoundError(name);
  }

  const updatedProject: Project = {
    id: existingProject.id,
    name: existingProject.name,
    displayName: updates.displayName ?? existingProject.displayName,
    repositories: updates.repositories ?? existingProject.repositories,
    description: updates.description ?? existingProject.description,
  };

  projects[index] = updatedProject;
  const writeResult = await writeValidatedJson(getProjectsFilePath(), projects, ProjectsSchema);
  if (!writeResult.ok) throw writeResult.error;

  return updatedProject;
}

/** Remove a project by slug. */
export async function removeProject(name: string): Promise<void> {
  const projects = await listProjects();
  const index = projects.findIndex((p) => p.name === name);

  if (index === -1) {
    throw new ProjectNotFoundError(name);
  }

  projects.splice(index, 1);
  const writeResult = await writeValidatedJson(getProjectsFilePath(), projects, ProjectsSchema);
  if (!writeResult.ok) throw writeResult.error;
}

/**
 * Add a repository to an existing project. Stamps an id if one isn't supplied.
 */
export async function addProjectRepo(
  name: string,
  repo: Omit<Repository, 'id' | 'name'> & { id?: string; name?: string }
): Promise<Project> {
  const project = await getProject(name);
  const resolvedPath = resolve(expandTilde(repo.path));

  const validation = await validateProjectPath(resolvedPath);
  if (!validation.ok) {
    throw new ValidationError(`Invalid path ${repo.path}: ${validation.error.message}`, repo.path);
  }

  if (project.repositories.some((r) => r.path === resolvedPath)) {
    return project; // Already exists, no-op
  }

  const normalizedRepo: Repository = {
    id: repo.id ?? generateUuid8(),
    name: repo.name && repo.name.length > 0 ? repo.name : basename(resolvedPath),
    path: resolvedPath,
    checkScript: repo.checkScript,
    checkTimeout: repo.checkTimeout,
  };

  return updateProject(name, {
    repositories: [...project.repositories, normalizedRepo],
  });
}

/**
 * Remove a repository from a project by path. Enforces at least one repo per
 * project.
 */
export async function removeProjectRepo(name: string, path: string): Promise<Project> {
  const project = await getProject(name);
  const resolvedPath = resolve(expandTilde(path));

  const newRepos = project.repositories.filter((r) => r.path !== resolvedPath);

  if (newRepos.length === 0) {
    throw new ValidationError('Cannot remove the last repository from a project', 'repositories');
  }

  if (newRepos.length === project.repositories.length) {
    return project; // Path wasn't in the list, no-op
  }

  return updateProject(name, { repositories: newRepos });
}
