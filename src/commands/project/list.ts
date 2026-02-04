import { muted } from '@src/theme/index.ts';
import { listProjects } from '@src/store/project.ts';
import { log, printHeader, showEmpty } from '@src/theme/ui.ts';

export async function projectListCommand(): Promise<void> {
  const projects = await listProjects();

  if (projects.length === 0) {
    showEmpty('projects', 'Add one with: ralphctl project add');
    return;
  }

  printHeader('Projects');

  for (const project of projects) {
    log.raw(`${project.name}  ${muted(project.displayName)}`);
    for (const repo of project.repositories) {
      log.item(`${repo.name} → ${repo.path}`);
    }
    if (project.description) {
      log.item(project.description);
    }
    log.newline();
  }
}
