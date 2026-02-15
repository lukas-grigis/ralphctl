import { execSync } from 'node:child_process';
import { assertSafeCwd, getProgressFilePath } from '@src/utils/paths.ts';
import { appendToFile, FileNotFoundError, readTextFile } from '@src/utils/storage.ts';
import { assertSprintStatus, getSprint, resolveSprintId } from '@src/store/sprint.ts';
import { withFileLock } from '@src/utils/file-lock.ts';
import { log } from '@src/theme/ui.ts';

export interface LogProgressOptions {
  sprintId?: string;
  projectPath?: string;
}

export async function logProgress(message: string, options: LogProgressOptions = {}): Promise<void> {
  const id = await resolveSprintId(options.sprintId);
  const sprint = await getSprint(id);

  // Check sprint status - must be active to log progress
  assertSprintStatus(sprint, ['active'], 'log progress');

  const timestamp = new Date().toISOString();
  const projectMarker = options.projectPath ? `**Project:** ${options.projectPath}\n\n` : '';
  const entry = `## ${timestamp}\n\n${projectMarker}${message}\n\n---\n\n`;
  const progressPath = getProgressFilePath(id);
  await withFileLock(progressPath, async () => {
    await appendToFile(progressPath, entry);
  });
}

function isExecError(err: unknown): err is Error & { status: number } {
  return err instanceof Error && typeof (err as unknown as Record<string, unknown>)['status'] === 'number';
}

function isNodeError(err: unknown): err is Error & { code: string } {
  return err instanceof Error && typeof (err as unknown as Record<string, unknown>)['code'] === 'string';
}

/**
 * Get the current git commit hash and message for a path.
 */
function getGitCommitInfo(projectPath: string): { hash: string; message: string } | null {
  try {
    assertSafeCwd(projectPath);
    // Single git command: "hash message"
    const output = execSync('git log -1 --pretty=format:%H\\ %s', {
      cwd: projectPath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    const spaceIndex = output.indexOf(' ');
    return {
      hash: output.slice(0, spaceIndex),
      message: output.slice(spaceIndex + 1),
    };
  } catch (err: unknown) {
    // Expected: not a git repo (exit code 128) — return null silently
    if (isExecError(err) && err.status === 128) {
      return null;
    }
    // Expected: git not installed (ENOENT) — return null silently
    if (isNodeError(err) && err.code === 'ENOENT') {
      return null;
    }
    // Unexpected: permission denied, corrupt repo, etc. — warn the user
    const detail = err instanceof Error ? err.message : String(err);
    log.warn(`Failed to get git info for ${projectPath}: ${detail}`);
    return null;
  }
}

export interface LogBaselinesOptions {
  sprintId: string;
  sprintName: string;
  projectPaths: string[];
}

/**
 * Log baseline git state for each project when a sprint is activated.
 * This enables "git log baseline..HEAD" style reviews of sprint changes.
 */
export async function logBaselines(options: LogBaselinesOptions): Promise<void> {
  const { sprintId, sprintName, projectPaths } = options;
  const timestamp = new Date().toISOString();

  const lines: string[] = [
    `## ${timestamp}`,
    '',
    '### Sprint Baseline State',
    '',
    `Sprint: ${sprintName} (${sprintId})`,
    `Activated: ${timestamp}`,
    '',
    '#### Project Git State at Activation',
    '',
  ];

  // Get unique paths
  const uniquePaths = [...new Set(projectPaths)];

  for (const path of uniquePaths) {
    const commitInfo = getGitCommitInfo(path);
    if (commitInfo) {
      lines.push(`- **${path}**`);
      lines.push(`  \`${commitInfo.hash} ${commitInfo.message}\``);
    } else {
      lines.push(`- **${path}**`);
      lines.push(`  *(not a git repository or unable to retrieve state)*`);
    }
  }

  lines.push('');
  lines.push('---');
  lines.push('');

  await appendToFile(getProgressFilePath(sprintId), lines.join('\n'));
}

export async function getProgress(sprintId?: string): Promise<string> {
  const id = await resolveSprintId(sprintId);
  try {
    return await readTextFile(getProgressFilePath(id));
  } catch (err) {
    if (err instanceof FileNotFoundError) {
      return '';
    }
    throw err;
  }
}

/**
 * Parse progress entries and filter by project path.
 * Entries are delimited by `---` and may contain project markers in either format:
 * - Legacy HTML comments: `<!-- project: /path -->`
 * - Visible format: `**Project:** /path`
 */
/**
 * Extract only "Learnings and Context" and "Notes for Next Tasks" sections
 * from progress entries, capped at maxEntries most recent.
 * Returns compressed summary suitable for task context files.
 */
export function summarizeProgressForContext(progress: string, projectPath: string, maxEntries = 3): string {
  const filtered = filterProgressByProject(progress, projectPath);
  if (!filtered.trim()) {
    return '';
  }

  // Split into entries by --- delimiter
  const entries = filtered.split(/\n---\n/).filter((e) => e.trim());

  // Take last maxEntries entries
  const recent = entries.slice(-maxEntries);

  const summaries: string[] = [];

  for (const entry of recent) {
    // Extract entry header (first ## line with timestamp and task name)
    const headerMatch = /^##\s+(.+)$/m.exec(entry);
    const header = headerMatch?.[1] ?? 'Unknown entry';

    // Extract "Learnings and Context" section
    const learnings = extractSection(entry, 'Learnings and Context');

    // Extract "Notes for Next Tasks" section
    const notes = extractSection(entry, 'Notes for Next Tasks');

    // Only include entries that have at least one useful section
    if (learnings || notes) {
      const parts: string[] = [`**${header}**`];
      if (learnings) {
        parts.push(`**Learnings:** ${learnings}`);
      }
      if (notes) {
        parts.push(`**Notes for next tasks:** ${notes}`);
      }
      summaries.push(parts.join('\n'));
    }
  }

  if (summaries.length === 0) {
    return '';
  }

  return summaries.join('\n\n');
}

/**
 * Extract content of a markdown section (### heading) from a progress entry.
 * Returns the section content trimmed, or null if section not found.
 */
function extractSection(entry: string, sectionName: string): string | null {
  // Match ### Section Name followed by content until next ### or end of string
  // No 'm' flag — $ must match end of string, not end of line
  const regex = new RegExp(`###\\s+${sectionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\n([\\s\\S]*?)(?=###|$)`);
  const match = regex.exec(entry);
  if (!match?.[1]) return null;

  const content = match[1].trim();
  return content || null;
}

export function filterProgressByProject(progress: string, projectPath: string): string {
  if (!progress.trim()) {
    return '';
  }

  // Split by entry delimiter
  const entries = progress.split(/\n---\n/).filter((e) => e.trim());

  const filtered = entries.filter((entry) => {
    // Try visible format first: **Project:** /some/path
    const visibleMatch = /\*\*Project:\*\*\s*(.+?)(?:\n|$)/.exec(entry);
    if (visibleMatch?.[1]) {
      return visibleMatch[1].trim() === projectPath;
    }

    // Fall back to legacy HTML comment format: <!-- project: /some/path -->
    const htmlMatch = /<!--\s*project:\s*(.+?)\s*-->/.exec(entry);
    if (htmlMatch?.[1]) {
      return htmlMatch[1] === projectPath;
    }

    // No marker = include (baseline entries, general notes)
    return true;
  });

  if (filtered.length === 0) {
    return '';
  }

  return filtered.join('\n---\n') + '\n\n---\n\n';
}
