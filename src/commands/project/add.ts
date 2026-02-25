import { existsSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { input, select } from '@inquirer/prompts';
import { error, muted } from '@src/theme/index.ts';
import { validateProjectPath } from '@src/utils/paths.ts';
import { createProject, ProjectExistsError } from '@src/store/project.ts';
import type { Project, Repository } from '@src/schemas/index.ts';
import {
  createSpinner,
  emoji,
  field,
  log,
  showError,
  showNextStep,
  showSuccess,
  showTip,
  showWarning,
} from '@src/theme/ui.ts';
import { EXIT_ERROR, exitWithCode } from '@src/utils/exit-codes.ts';
import { browseDirectory } from '@src/interactive/file-browser.ts';
import { detectCheckScriptCandidates, suggestCheckScript } from '@src/utils/detect-scripts.ts';

export interface ProjectAddOptions {
  name?: string;
  displayName?: string;
  paths?: string[];
  description?: string;
  checkScript?: string;
  interactive?: boolean; // Set by REPL, not a CLI flag
}

function validateSlug(slug: string): boolean {
  return /^[a-z0-9-]+$/.test(slug);
}

/**
 * Check if a path is a git repository.
 */
function isGitRepo(path: string): boolean {
  try {
    const gitDir = join(path, '.git');
    return existsSync(gitDir) && statSync(gitDir).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Check if an AI provider instructions file exists (CLAUDE.md or .github/copilot-instructions.md).
 */
function hasAiInstructions(repoPath: string): boolean {
  return existsSync(join(repoPath, 'CLAUDE.md')) || existsSync(join(repoPath, '.github', 'copilot-instructions.md'));
}

/**
 * Add check script to a repository interactively.
 * Exported so `project repo add` can reuse the same flow.
 */
export async function addCheckScriptToRepository(repo: Repository): Promise<Repository> {
  let suggested: string | null = null;

  try {
    const detection = detectCheckScriptCandidates(repo.path);
    if (detection) {
      log.success(`  Detected: ${detection.typeLabel}`);
      suggested = suggestCheckScript(repo.path);
    }
  } catch {
    // Auto-detection failed, continue with manual entry
  }

  const checkInput = await input({
    message: '  Check script (optional):',
    default: suggested ?? undefined,
  });
  const checkScript = checkInput.trim() || undefined;

  return {
    ...repo,
    checkScript,
  };
}

export async function projectAddCommand(options: ProjectAddOptions = {}): Promise<void> {
  let name: string;
  let displayName: string;
  let repositories: Repository[];
  let description: string | undefined;

  if (options.interactive === false) {
    // Non-interactive mode: validate required params
    const errors: string[] = [];
    const trimmedName = options.name?.trim();
    const trimmedDisplayName = options.displayName?.trim();

    if (!trimmedName) {
      errors.push('--name is required');
    } else if (!validateSlug(trimmedName)) {
      errors.push('--name must be a slug (lowercase, numbers, hyphens only)');
    }

    if (!trimmedDisplayName) {
      errors.push('--display-name is required');
    }

    if (!options.paths || options.paths.length === 0) {
      errors.push('--path is required (at least one)');
    }

    // Validate paths
    if (options.paths) {
      const spinner = options.paths.length > 1 ? createSpinner('Validating repository paths...').start() : null;
      for (const path of options.paths) {
        const resolved = resolve(path.trim());
        const validation = await validateProjectPath(resolved);
        if (validation !== true) {
          errors.push(`--path ${path}: ${validation}`);
        }
      }
      spinner?.succeed('Paths validated');
    }

    if (errors.length > 0 || !trimmedName || !trimmedDisplayName || !options.paths) {
      showError('Validation failed');
      for (const e of errors) {
        log.item(error(e));
      }
      console.log('');
      exitWithCode(EXIT_ERROR);
    }

    name = trimmedName;
    displayName = trimmedDisplayName;
    // Convert paths to repositories with auto-derived names
    // In non-interactive mode, apply CLI flags if provided (otherwise no scripts)
    repositories = options.paths.map((p) => {
      const resolved = resolve(p.trim());
      const repo: Repository = { name: basename(resolved), path: resolved };
      if (options.checkScript) repo.checkScript = options.checkScript;
      return repo;
    });
    const trimmedDesc = options.description?.trim();
    description = trimmedDesc === '' ? undefined : trimmedDesc;
  } else {
    // Interactive mode (default) - prompt for missing params
    name = await input({
      message: 'Project name (slug):',
      default: options.name?.trim(),
      validate: (v) => {
        const trimmed = v.trim();
        if (trimmed.length === 0) return 'Name is required';
        if (!validateSlug(trimmed)) return 'Must be lowercase with hyphens only';
        return true;
      },
    });
    name = name.trim();

    displayName = await input({
      message: 'Display name:',
      default: options.displayName?.trim() ?? name,
      validate: (v) => (v.trim().length > 0 ? true : 'Display name is required'),
    });
    displayName = displayName.trim();

    // Collect repositories
    repositories = [];

    // Add any paths from options first
    if (options.paths) {
      for (const p of options.paths) {
        const resolved = resolve(p.trim());
        const validation = await validateProjectPath(resolved);
        if (validation === true) {
          repositories.push({ name: basename(resolved), path: resolved });
        }
      }
    }

    // Ask for at least one path if none provided
    if (repositories.length === 0) {
      const pathMethod = await select({
        message: `${emoji.donut} How to specify repository path?`,
        choices: [
          { name: 'Browse filesystem', value: 'browse', description: 'Navigate from home folder' },
          { name: 'Use current directory', value: 'cwd', description: process.cwd() },
          { name: 'Type path manually', value: 'manual' },
        ],
      });

      let firstPath: string;

      if (pathMethod === 'browse') {
        const browsed = await browseDirectory('Select repository directory:');
        if (!browsed) {
          showError('No directory selected');
          exitWithCode(EXIT_ERROR);
        }
        firstPath = browsed;
      } else if (pathMethod === 'cwd') {
        firstPath = process.cwd();
      } else {
        firstPath = await input({
          message: 'Repository path:',
          default: process.cwd(),
          validate: async (v) => {
            const result = await validateProjectPath(v.trim());
            return result;
          },
        });
        firstPath = firstPath.trim();
      }

      const resolved = resolve(firstPath);
      const validation = await validateProjectPath(resolved);
      if (validation !== true) {
        showError(`Invalid path: ${validation}`);
        exitWithCode(EXIT_ERROR);
      }
      repositories.push({ name: basename(resolved), path: resolved });
    }

    // Process first repository with scripts
    const firstRepo = repositories[0];
    if (firstRepo) {
      // Check for git repo
      if (!isGitRepo(firstRepo.path)) {
        showWarning('Path is not a git repository');
      }

      // Check for AI instructions file
      if (!hasAiInstructions(firstRepo.path)) {
        showTip('Add CLAUDE.md or .github/copilot-instructions.md for better AI assistance');
      }

      // Add scripts to first repository
      log.info(`\nConfiguring: ${firstRepo.name}`);
      repositories[0] = await addCheckScriptToRepository(firstRepo);
    }

    // Ask for additional paths
    let addMore = true;
    while (addMore) {
      const addAction = await select({
        message: `${emoji.donut} Add another repository?`,
        choices: [
          { name: 'No, done adding repositories', value: 'done' },
          { name: 'Browse filesystem', value: 'browse' },
          { name: 'Type path manually', value: 'manual' },
        ],
      });

      if (addAction === 'done') {
        addMore = false;
      } else if (addAction === 'browse') {
        const browsed = await browseDirectory('Select repository directory:');
        if (browsed) {
          const resolved = resolve(browsed);
          const validation = await validateProjectPath(resolved);
          if (validation === true) {
            const newRepo = { name: basename(resolved), path: resolved };
            log.success(`Added: ${newRepo.name}`);
            // Add scripts for this repository
            const repoWithScripts = await addCheckScriptToRepository(newRepo);
            repositories.push(repoWithScripts);
          } else {
            log.error(`Invalid path: ${validation}`);
          }
        }
      } else {
        const additionalPath = await input({
          message: 'Repository path:',
        });

        if (additionalPath.trim() === '') {
          addMore = false;
        } else {
          const resolved = resolve(additionalPath.trim());
          const validation = await validateProjectPath(resolved);
          if (validation === true) {
            const newRepo = { name: basename(resolved), path: resolved };
            log.success(`Added: ${newRepo.name}`);
            // Add scripts for this repository
            const repoWithScripts = await addCheckScriptToRepository(newRepo);
            repositories.push(repoWithScripts);
          } else {
            log.error(`Invalid path: ${validation}`);
          }
        }
      }
    }

    description = await input({
      message: 'Description (optional):',
      default: options.description?.trim(),
    });
    const trimmedDescInteractive = description.trim();
    description = trimmedDescInteractive === '' ? undefined : trimmedDescInteractive;
  }

  try {
    const project: Project = {
      name,
      displayName,
      repositories,
      description,
    };

    const created = await createProject(project);

    showSuccess('Project added!', [
      ['Name', created.name],
      ['Display Name', created.displayName],
    ]);
    if (created.description) {
      console.log(field('Description', created.description));
    }
    console.log(field('Repositories', ''));
    for (const repo of created.repositories) {
      log.item(`${repo.name} → ${repo.path}`);
      if (repo.checkScript) {
        console.log(`        Check: ${repo.checkScript}`);
      } else {
        console.log(`        Check: ${muted('(not configured)')}`);
      }
    }
    console.log('');
  } catch (err) {
    if (err instanceof ProjectExistsError) {
      showError(`Project "${name}" already exists.`);
      showNextStep(`ralphctl project remove ${name}`, 'remove existing project first');
      log.newline();
    } else {
      throw err;
    }
  }
}
