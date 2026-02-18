import { fileURLToPath } from 'node:url';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { lstat, realpath, stat } from 'node:fs/promises';

// Repo root: always the cloned repo directory (for schemas, etc.)
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function getRepoRoot(): string {
  return join(__dirname, '..', '..');
}

// Data directory: RALPHCTL_ROOT env var (if set) or {repoRoot}/ralphctl-data/
export function getDataDir(): string {
  return process.env['RALPHCTL_ROOT'] ?? join(getRepoRoot(), 'ralphctl-data');
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
  return join(getRepoRoot(), 'schemas', schemaName);
}

/**
 * Validate a path is safe to use as execSync/spawn cwd.
 * Rejects null bytes, newlines, and non-absolute paths.
 * @throws Error if path is unsafe
 */
export function assertSafeCwd(path: string): void {
  if (!path || path.includes('\0') || path.includes('\n') || path.includes('\r')) {
    throw new Error('Unsafe path for cwd: contains null bytes or newlines');
  }
  if (!isAbsolute(path)) {
    throw new Error(`Unsafe path for cwd: must be absolute, got: ${path}`);
  }
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
