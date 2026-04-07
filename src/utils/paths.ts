import { fileURLToPath } from 'node:url';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { lstat, realpath, stat } from 'node:fs/promises';
import { Result } from 'typescript-result';
import { IOError } from '@src/errors.ts';

// Repo/package root: walk up from __dirname to find package.json.
// Works in both dev (src/utils/) and dist (dist/) contexts.
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function getRepoRoot(): string {
  let dir = __dirname;
  while (dir !== dirname(dir)) {
    if (existsSync(join(dir, 'package.json'))) {
      return dir;
    }
    dir = dirname(dir);
  }
  return join(__dirname, '..', '..');
}

// Data directory: RALPHCTL_ROOT env var (if set) or ~/.ralphctl/
export function getDataDir(): string {
  return process.env['RALPHCTL_ROOT'] ?? join(homedir(), '.ralphctl');
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
  const sprintsDir = getSprintsDir();
  const resolved = resolve(sprintsDir, sprintId);
  if (!resolved.startsWith(sprintsDir + sep) && resolved !== sprintsDir) {
    throw new Error(`Path traversal detected in sprint ID: ${sprintId}`);
  }
  return resolved;
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

export function getEvaluationsDir(sprintId: string): string {
  return join(getSprintDir(sprintId), 'evaluations');
}

export function getEvaluationFilePath(sprintId: string, taskId: string): string {
  assertSafeSegment(taskId, 'task ID');
  return join(getEvaluationsDir(sprintId), `${taskId}.md`);
}

/** Validate a segment (ticketId, etc.) does not contain path traversal. */
function assertSafeSegment(segment: string, label: string): void {
  if (!segment || segment.includes('/') || segment.includes('\\') || segment.includes('..') || segment.includes('\0')) {
    throw new Error(`Path traversal detected in ${label}: ${segment}`);
  }
}

export function getRefinementDir(sprintId: string, ticketId: string): string {
  assertSafeSegment(ticketId, 'ticket ID');
  return join(getSprintDir(sprintId), 'refinement', ticketId);
}

export function getPlanningDir(sprintId: string): string {
  return join(getSprintDir(sprintId), 'planning');
}

export function getIdeateDir(sprintId: string, ticketId: string): string {
  assertSafeSegment(ticketId, 'ticket ID');
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
 * Expand a leading `~` or `~/` to the user's home directory.
 * Returns the path unchanged if it does not start with `~`.
 */
export function expandTilde(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return homedir() + path.slice(1);
  return path;
}

/**
 * Validate that a path exists and is a directory.
 * Returns a Result: ok(true) if valid, or an IOError with a descriptive message if invalid.
 */
export async function validateProjectPath(path: string) {
  try {
    const resolved = resolve(expandTilde(path));
    const lstats = await lstat(resolved);
    if (lstats.isSymbolicLink()) {
      const realPath = await realpath(resolved);
      const realStats = await stat(realPath);
      if (!realStats.isDirectory()) {
        return Result.error(new IOError('Symlink target is not a directory'));
      }
      return Result.ok(true);
    }
    if (!lstats.isDirectory()) {
      return Result.error(new IOError('Path is not a directory'));
    }
    return Result.ok(true);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    const message = code === 'EACCES' ? 'Permission denied' : 'Directory does not exist';
    return Result.error(new IOError(message, err instanceof Error ? err : undefined));
  }
}
