import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { select } from '@inquirer/prompts';
import { emoji } from '@src/theme/ui.ts';
import { muted } from '@src/theme/index.ts';

interface BrowseChoice {
  name: string;
  value: string;
  description?: string;
}

/**
 * List directories in a path, sorted alphabetically.
 * Excludes hidden directories (starting with .).
 */
function listDirectories(dirPath: string): string[] {
  try {
    const entries = readdirSync(dirPath, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  } catch {
    return [];
  }
}

/**
 * Check if a directory contains subdirectories.
 */
function hasSubdirectories(dirPath: string): boolean {
  try {
    const entries = readdirSync(dirPath, { withFileTypes: true });
    return entries.some((e) => e.isDirectory() && !e.name.startsWith('.'));
  } catch {
    return false;
  }
}

/**
 * Check if a path is likely a git repository.
 */
function isGitRepo(dirPath: string): boolean {
  try {
    const gitDir = join(dirPath, '.git');
    return statSync(gitDir).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Interactive filesystem browser starting from home directory.
 * Returns the selected directory path or null if cancelled.
 */
export async function browseDirectory(message = 'Browse to directory:', startPath?: string): Promise<string | null> {
  let currentPath = startPath ? resolve(startPath) : homedir();

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- loop control
  while (true) {
    const dirs = listDirectories(currentPath);
    const choices: BrowseChoice[] = [];

    // Navigation options
    choices.push({
      name: `${emoji.donut} Select this directory`,
      value: '__SELECT__',
      description: currentPath,
    });

    // Parent directory (if not at root)
    const parentDir = dirname(currentPath);
    if (parentDir !== currentPath) {
      choices.push({
        name: '↑ Parent directory',
        value: '__PARENT__',
        description: parentDir,
      });
    }

    // Home directory shortcut
    if (currentPath !== homedir()) {
      choices.push({
        name: '⌂ Home directory',
        value: '__HOME__',
        description: homedir(),
      });
    }

    // Subdirectories
    for (const dir of dirs) {
      const fullPath = join(currentPath, dir);
      const hasChildren = hasSubdirectories(fullPath);
      const isRepo = isGitRepo(fullPath);

      let icon = '  ';
      if (isRepo) {
        icon = '⚙ '; // Git repo indicator
      } else if (hasChildren) {
        icon = '▸ '; // Has subdirectories
      }

      choices.push({
        name: `${icon}${dir}`,
        value: fullPath,
        description: isRepo ? 'git repo' : undefined,
      });
    }

    // Cancel option
    choices.push({
      name: muted('Cancel'),
      value: '__CANCEL__',
    });

    try {
      const selected = await select({
        message: `${emoji.donut} ${message}\n   ${muted(currentPath)}`,
        choices,
        pageSize: 15,
        loop: false,
      });

      switch (selected) {
        case '__SELECT__':
          return currentPath;
        case '__PARENT__':
          currentPath = parentDir;
          break;
        case '__HOME__':
          currentPath = homedir();
          break;
        case '__CANCEL__':
          return null;
        default:
          // Navigate into selected directory
          currentPath = selected;
      }
    } catch (err) {
      // Handle Ctrl+C / escape
      if ((err as Error).name === 'ExitPromptError') {
        return null;
      }
      throw err;
    }
  }
}
