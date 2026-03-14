import { ensureError, wrapAsync } from '@src/utils/result-helpers.ts';
import { colors, muted } from '@src/theme/index.ts';
import { getProject, ProjectNotFoundError } from '@src/store/project.ts';
import { selectProject } from '@src/interactive/selectors.ts';
import { icons, labelValue, log, renderCard, showError } from '@src/theme/ui.ts';

export async function projectShowCommand(args: string[]): Promise<void> {
  let projectName = args[0];

  if (!projectName) {
    const selected = await selectProject('Select project to show:');
    if (!selected) return;
    projectName = selected;
  }

  const projectR = await wrapAsync(() => getProject(projectName), ensureError);
  if (!projectR.ok) {
    if (projectR.error instanceof ProjectNotFoundError) {
      showError(`Project not found: ${projectName}`);
      log.newline();
    } else {
      throw projectR.error;
    }
    return;
  }
  const project = projectR.value;

  // Project info card
  const infoLines: string[] = [labelValue('Name', project.name), labelValue('Display Name', project.displayName)];
  if (project.description) {
    infoLines.push(labelValue('Description', project.description));
  }
  infoLines.push(labelValue('Repositories', String(project.repositories.length)));

  log.newline();
  console.log(renderCard(`${icons.project} ${project.displayName}`, infoLines));

  // Repository cards
  for (const repo of project.repositories) {
    log.newline();
    const repoLines: string[] = [labelValue('Path', repo.path)];
    if (repo.checkScript) {
      repoLines.push(labelValue('Check', colors.info(repo.checkScript)));
    } else {
      repoLines.push(muted('No check script configured'));
    }
    console.log(renderCard(`  ${repo.name}`, repoLines));
  }

  log.newline();
}
