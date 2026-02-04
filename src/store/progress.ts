import { execSync } from 'node:child_process';
import { getProgressFilePath } from '@src/utils/paths.ts';
import { appendToFile, FileNotFoundError, readTextFile } from '@src/utils/storage.ts';
import { assertSprintStatus, getSprint, resolveSprintId } from '@src/store/sprint.ts';

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
  await appendToFile(getProgressFilePath(id), entry);
}

/**
 * Get the current git commit hash and message for a path.
 */
function getGitCommitInfo(projectPath: string): { hash: string; message: string } | null {
  try {
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
  } catch {
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
