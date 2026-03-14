import { basename, resolve } from 'node:path';
import { expandTilde, getProjectsFilePath, validateProjectPath } from '../utils/paths.js';
import { fileExists, readValidatedJson, writeValidatedJson } from '../utils/storage.js';
import { type Project, type Projects, ProjectsSchema, type Repository } from '../schemas/index.js';

export { ProjectNotFoundError, ProjectExistsError } from '../errors.js';
import { ProjectNotFoundError, ProjectExistsError, ParseError } from '../errors.js';

/**
 * Migration: Convert old paths[] format to repositories[] format.
 * Non-production tool - minimal migration support.
 */
interface LegacyProject {
  name: string;
  displayName: string;
  paths?: string[];
  repositories?: Repository[];
  description?: string;
}

function migrateProjectIfNeeded(project: LegacyProject): Project {
  // Already in new format
  if (project.repositories) {
    return project as Project;
  }

  // Old paths[] format - convert to repositories[]
  if (project.paths) {
    return {
      name: project.name,
      displayName: project.displayName,
      repositories: project.paths.map((p) => ({
        name: basename(p),
        path: resolve(expandTilde(p)),
      })),
      description: project.description,
    };
  }

  throw new ParseError(`Invalid project data: no paths or repositories for ${project.name}`);
}

/**
 * Get all projects.
 * Handles migration from old paths[] format to repositories[] format.
 */
export async function listProjects(): Promise<Projects> {
  const filePath = getProjectsFilePath();
  if (!(await fileExists(filePath))) {
    return [];
  }

  // Read raw data to check for migration needs
  const { readFile } = await import('node:fs/promises');
  const content = await readFile(filePath, 'utf-8');
  const rawData = JSON.parse(content) as LegacyProject[];

  // Check if any projects need migration (old paths[] format)
  const needsMigration = rawData.some((p) => p.paths && !p.repositories);

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

  // One-time cleanup: correct any tilde paths stored before write-time expansion was added.
  // Safe to remove once existing users have been migrated.
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

/**
 * Get a project by name.
 * @throws ProjectNotFoundError if project doesn't exist
 */
export async function getProject(name: string): Promise<Project> {
  const projects = await listProjects();
  const project = projects.find((p) => p.name === name);
  if (!project) {
    throw new ProjectNotFoundError(name);
  }
  return project;
}

/**
 * Check if a project exists.
 */
export async function projectExists(name: string): Promise<boolean> {
  const projects = await listProjects();
  return projects.some((p) => p.name === name);
}

/**
 * Create a new project.
 * @throws ProjectExistsError if project already exists
 */
export async function createProject(project: Project): Promise<Project> {
  const projects = await listProjects();

  if (projects.some((p) => p.name === project.name)) {
    throw new ProjectExistsError(project.name);
  }

  // Validate that all repository paths exist
  const pathErrors: string[] = [];
  for (const repo of project.repositories) {
    const resolved = resolve(expandTilde(repo.path));
    const validation = await validateProjectPath(resolved);
    if (!validation.ok) {
      pathErrors.push(`  ${repo.path}: ${validation.error.message}`);
    }
  }
  if (pathErrors.length > 0) {
    throw new Error(`Invalid project paths:\n${pathErrors.join('\n')}`);
  }

  // Resolve all paths to absolute and derive names, preserving scripts
  const normalizedProject: Project = {
    ...project,
    repositories: project.repositories.map((repo) => ({
      ...repo,
      name: repo.name || basename(repo.path),
      path: resolve(expandTilde(repo.path)),
    })),
  };

  projects.push(normalizedProject);
  const writeResult = await writeValidatedJson(getProjectsFilePath(), projects, ProjectsSchema);
  if (!writeResult.ok) throw writeResult.error;

  return normalizedProject;
}

/**
 * Update an existing project.
 * @throws ProjectNotFoundError if project doesn't exist
 */
export async function updateProject(name: string, updates: Partial<Omit<Project, 'name'>>): Promise<Project> {
  const projects = await listProjects();
  const index = projects.findIndex((p) => p.name === name);

  if (index === -1) {
    throw new ProjectNotFoundError(name);
  }

  // Validate new repositories if provided
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
      throw new Error(`Invalid project paths:\n${pathErrors.join('\n')}`);
    }
    // Resolve paths to absolute and ensure names, preserving scripts
    updates.repositories = updates.repositories.map((repo) => ({
      ...repo,
      name: repo.name || basename(repo.path),
      path: resolve(expandTilde(repo.path)),
    }));
  }

  const existingProject = projects[index];
  if (!existingProject) {
    throw new ProjectNotFoundError(name);
  }

  const updatedProject: Project = {
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

/**
 * Remove a project.
 * @throws ProjectNotFoundError if project doesn't exist
 */
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
 * Get all repositories for a project.
 * @throws ProjectNotFoundError if project doesn't exist
 */
export async function getProjectRepos(name: string): Promise<Repository[]> {
  const project = await getProject(name);
  return project.repositories;
}

/**
 * Add a repository to an existing project.
 * Accepts a full Repository object to preserve scripts set during interactive prompting.
 * @throws ProjectNotFoundError if project doesn't exist
 */
export async function addProjectRepo(name: string, repo: Repository): Promise<Project> {
  const project = await getProject(name);
  const resolvedPath = resolve(expandTilde(repo.path));

  // Validate the path
  const validation = await validateProjectPath(resolvedPath);
  if (!validation.ok) {
    throw new Error(`Invalid path ${repo.path}: ${validation.error.message}`);
  }

  // Check if path already exists
  if (project.repositories.some((r) => r.path === resolvedPath)) {
    return project; // Already exists, no-op
  }

  const normalizedRepo: Repository = {
    ...repo,
    name: repo.name || basename(resolvedPath),
    path: resolvedPath,
  };

  return updateProject(name, {
    repositories: [...project.repositories, normalizedRepo],
  });
}

/**
 * Remove a repository from an existing project.
 * @throws ProjectNotFoundError if project doesn't exist
 * @throws Error if trying to remove the last repository
 */
export async function removeProjectRepo(name: string, path: string): Promise<Project> {
  const project = await getProject(name);
  const resolvedPath = resolve(expandTilde(path));

  const newRepos = project.repositories.filter((r) => r.path !== resolvedPath);

  if (newRepos.length === 0) {
    throw new Error('Cannot remove the last repository from a project');
  }

  if (newRepos.length === project.repositories.length) {
    return project; // Path wasn't in the list, no-op
  }

  return updateProject(name, { repositories: newRepos });
}
