import { basename, resolve } from 'node:path';
import { expandTilde } from '@src/integration/persistence/paths.ts';
import { getPrompt } from '@src/application/bootstrap.ts';
import { ensureError, wrapAsync } from '@src/integration/utils/result-helpers.ts';
import { muted } from '@src/integration/ui/theme/theme.ts';
import {
  addProjectRepo,
  getProject,
  ProjectNotFoundError,
  removeProjectRepo,
} from '@src/integration/persistence/project.ts';
import { selectProject } from '@src/integration/cli/commands/shared/selectors.ts';
import { emoji, log, showError, showSuccess } from '@src/integration/ui/theme/ui.ts';
import { addCheckScriptToRepository } from '@src/integration/cli/commands/project/add.ts';

export async function projectRepoAddCommand(args: string[]): Promise<void> {
  let projectName = args[0];
  let path = args[1];

  // Interactive: select project if not provided
  if (!projectName) {
    const selected = await selectProject('Select project to add repository to:');
    if (!selected) return;
    projectName = selected;
  }

  // Interactive: ask for path if not provided
  path ??= await getPrompt().input({
    message: `${emoji.donut} Repository path to add:`,
    validate: (v) => (v.trim().length > 0 ? true : 'Path is required'),
  });

  const resolvedPath = resolve(expandTilde(path));
  const bareRepo = { name: basename(resolvedPath), path: resolvedPath };

  // Prompt for setup/verify scripts (with heuristic suggestions)
  log.info(`\nConfiguring: ${bareRepo.name}`);
  const repoWithScripts = await addCheckScriptToRepository(bareRepo);

  const addR = await wrapAsync(() => addProjectRepo(projectName, repoWithScripts), ensureError);
  if (!addR.ok) {
    if (addR.error instanceof ProjectNotFoundError) {
      showError(`Project not found: ${projectName}`);
    } else {
      showError(addR.error.message);
    }
    log.newline();
    return;
  }

  showSuccess('Repository added', [['Project', projectName]]);
  log.newline();
  log.info('Current repositories:');
  for (const repo of addR.value.repositories) {
    log.item(`${repo.name} → ${repo.path}`);
  }
  log.newline();
}

export async function projectRepoRemoveCommand(args: string[]): Promise<void> {
  const skipConfirm = args.includes('-y') || args.includes('--yes');
  const filteredArgs = args.filter((a) => !a.startsWith('-'));
  let projectName = filteredArgs[0];
  let path = filteredArgs[1];

  // Interactive: select project if not provided
  if (!projectName) {
    const selected = await selectProject('Select project to remove repository from:');
    if (!selected) return;
    projectName = selected;
  }

  const projectR = await wrapAsync(() => getProject(projectName), ensureError);
  if (!projectR.ok) {
    if (projectR.error instanceof ProjectNotFoundError) {
      showError(`Project not found: ${projectName}`);
    } else {
      showError(projectR.error.message);
    }
    log.newline();
    return;
  }
  const project = projectR.value;

  // Interactive: select repository if not provided
  if (!path) {
    if (project.repositories.length === 0) {
      console.log(muted('\nNo repositories to remove.\n'));
      return;
    }

    path = await getPrompt().select({
      message: `${emoji.donut} Select repository to remove:`,
      choices: project.repositories.map((r) => ({
        label: `${r.name} (${r.path})`,
        value: r.path,
      })),
    });
  }

  if (!skipConfirm) {
    const confirmed = await getPrompt().confirm({
      message: `Remove repository "${path}" from project "${project.displayName}"?`,
      default: false,
    });

    if (!confirmed) {
      console.log(muted('\nRepository removal cancelled.\n'));
      return;
    }
  }

  const removeR = await wrapAsync(() => removeProjectRepo(projectName, path), ensureError);
  if (!removeR.ok) {
    if (removeR.error instanceof ProjectNotFoundError) {
      showError(`Project not found: ${projectName}`);
    } else {
      showError(removeR.error.message);
    }
    log.newline();
    return;
  }

  showSuccess('Repository removed', [['Project', projectName]]);
  log.newline();
  log.info('Remaining repositories:');
  for (const repo of removeR.value.repositories) {
    log.item(`${repo.name} → ${repo.path}`);
  }
  log.newline();
}
