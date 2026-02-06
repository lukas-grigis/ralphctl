import { colors, muted } from '@src/theme/index.ts';
import { getProject, ProjectNotFoundError } from '@src/store/project.ts';
import { selectProject } from '@src/interactive/selectors.ts';
import { icons, log, renderCard, showError } from '@src/theme/ui.ts';

const LABEL_W = 14;

function labelValue(label: string, value: string): string {
  const paddedLabel = (label + ':').padEnd(LABEL_W);
  return `${colors.muted(paddedLabel)} ${value}`;
}

export async function projectShowCommand(args: string[]): Promise<void> {
  let projectName = args[0];

  if (!projectName) {
    const selected = await selectProject('Select project to show:');
    if (!selected) return;
    projectName = selected;
  }

  try {
    const project = await getProject(projectName);

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
      if (repo.setupScript) {
        repoLines.push(labelValue('Setup', colors.info(repo.setupScript)));
      }
      if (repo.verifyScript) {
        repoLines.push(labelValue('Verify', colors.info(repo.verifyScript)));
      }
      if (!repo.setupScript && !repo.verifyScript) {
        repoLines.push(muted('No scripts configured'));
      }
      console.log(renderCard(`  ${repo.name}`, repoLines));
    }

    log.newline();
  } catch (err) {
    if (err instanceof ProjectNotFoundError) {
      showError(`Project not found: ${projectName}`);
      log.newline();
    } else {
      throw err;
    }
  }
}
