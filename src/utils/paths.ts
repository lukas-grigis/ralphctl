import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { lstat, realpath, stat } from 'node:fs/promises';

// Get the ralphctl root directory
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Use a function to allow tests to override RALPHCTL_ROOT via env variable
export function getRalphctlRoot(): string {
  return process.env['RALPHCTL_ROOT'] ?? join(__dirname, '..', '..');
}

// Backward compatibility constant - reads from env at module load time
export const RALPHCTL_ROOT = getRalphctlRoot();

// Data directory (git-ignored)
export function getDataDir(): string {
  return join(getRalphctlRoot(), 'ralphctl-data');
}

// Config path (moved to data directory)
export function getConfigPath(): string {
  return join(getDataDir(), 'config.json');
}

// Projects file path
export function getProjectsFilePath(): string {
  return join(getDataDir(), 'projects.json');
}

// Sprint directory and file paths
export function getSprintsDir(): string {
  return join(getDataDir(), 'sprints');
}

export function getSprintDir(sprintId: string): string {
  return join(getSprintsDir(), sprintId);
}

export function getSprintFilePath(sprintId: string): string {
  return join(getSprintDir(sprintId), 'sprint.json');
}

export function getTasksFilePath(sprintId: string): string {
  return join(getSprintDir(sprintId), 'tasks.json');
}

export function getProgressFilePath(sprintId: string): string {
  return join(getSprintDir(sprintId), 'progress.md');
}

export function getRefinementDir(sprintId: string, ticketId: string): string {
  return join(getSprintDir(sprintId), 'refinement', ticketId);
}

export function getPlanningDir(sprintId: string): string {
  return join(getSprintDir(sprintId), 'planning');
}

export function getIdeateDir(sprintId: string, ticketId: string): string {
  return join(getSprintDir(sprintId), 'ideation', ticketId);
}

export function getSchemaPath(schemaName: string): string {
  return join(getRalphctlRoot(), 'schemas', schemaName);
}

/**
 * Validate that a path exists and is a directory.
 * Returns `true` if valid, or an error message string if invalid.
 */
export async function validateProjectPath(path: string): Promise<string | true> {
  try {
    const resolved = resolve(path);
    const lstats = await lstat(resolved);
    if (lstats.isSymbolicLink()) {
      const realPath = await realpath(resolved);
      const realStats = await stat(realPath);
      if (!realStats.isDirectory()) {
        return 'Symlink target is not a directory';
      }
      return true;
    }
    if (!lstats.isDirectory()) {
      return 'Path is not a directory';
    }
    return true;
  } catch {
    return 'Directory does not exist';
  }
}
