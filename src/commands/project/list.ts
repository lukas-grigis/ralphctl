import { colors, muted } from '@src/theme/index.ts';
import { listProjects } from '@src/store/project.ts';
import { icons, log, printHeader, showEmpty } from '@src/theme/ui.ts';

export async function projectListCommand(): Promise<void> {
  const projects = await listProjects();

  if (projects.length === 0) {
    showEmpty('projects', 'Add one with: ralphctl project add');
    return;
  }

  printHeader('Projects', icons.project);

  for (const project of projects) {
    const repoCount = muted(
      `(${String(project.repositories.length)} repo${project.repositories.length !== 1 ? 's' : ''})`
    );
    log.raw(`${colors.highlight(project.name)}  ${project.displayName}  ${repoCount}`);
    for (const repo of project.repositories) {
      log.item(`${repo.name} ${muted('→')} ${muted(repo.path)}`);
    }
    if (project.description) {
      log.dim(`    ${project.description}`);
    }
    log.newline();
  }
}
