import { basename, resolve } from 'node:path';
import { expandTilde } from '@src/utils/paths.ts';
import { confirm, input, select } from '@inquirer/prompts';
import { wrapAsync } from '@src/utils/result-helpers.ts';
import { muted } from '@src/theme/index.ts';
import { addProjectRepo, getProject, ProjectNotFoundError, removeProjectRepo } from '@src/store/project.ts';
import { selectProject } from '@src/interactive/selectors.ts';
import { emoji, log, showError, showSuccess } from '@src/theme/ui.ts';
import { addCheckScriptToRepository } from '@src/commands/project/add.ts';

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
  path ??= await input({
    message: `${emoji.donut} Repository path to add:`,
    validate: (v) => (v.trim().length > 0 ? true : 'Path is required'),
  });

  const resolvedPath = resolve(expandTilde(path));
  const bareRepo = { name: basename(resolvedPath), path: resolvedPath };

  // Prompt for setup/verify scripts (with heuristic suggestions)
  log.info(`\nConfiguring: ${bareRepo.name}`);
  const repoWithScripts = await addCheckScriptToRepository(bareRepo);

  const addR = await wrapAsync(
    () => addProjectRepo(projectName, repoWithScripts),
    (err) => (err instanceof Error ? err : new Error(String(err)))
  );
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

  const projectR = await wrapAsync(
    () => getProject(projectName),
    (err) => (err instanceof Error ? err : new Error(String(err)))
  );
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

    path = await select({
      message: `${emoji.donut} Select repository to remove:`,
      choices: project.repositories.map((r) => ({
        name: `${r.name} (${r.path})`,
        value: r.path,
      })),
    });
  }

  if (!skipConfirm) {
    const confirmed = await confirm({
      message: `Remove repository "${path}" from project "${project.displayName}"?`,
      default: false,
    });

    if (!confirmed) {
      console.log(muted('\nRepository removal cancelled.\n'));
      return;
    }
  }

  const removeR = await wrapAsync(
    () => removeProjectRepo(projectName, path),
    (err) => (err instanceof Error ? err : new Error(String(err)))
  );
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
