import { getProject, ProjectNotFoundError } from '@src/store/project.ts';
import { selectProject } from '@src/interactive/selectors.ts';
import { field, log, printHeader, showError } from '@src/theme/ui.ts';

export async function projectShowCommand(args: string[]): Promise<void> {
  let projectName = args[0];

  if (!projectName) {
    const selected = await selectProject('Select project to show:');
    if (!selected) return;
    projectName = selected;
  }

  try {
    const project = await getProject(projectName);

    printHeader('Project Details');
    console.log(field('Name', project.name));
    console.log(field('Display Name', project.displayName));
    console.log(field('Repositories', ''));
    for (const repo of project.repositories) {
      log.item(`${repo.name} → ${repo.path}`);
    }
    if (project.description) {
      console.log(field('Description', project.description));
    }
    if (project.setupScript) {
      console.log(field('Setup', project.setupScript));
    }
    if (project.verifyScript) {
      console.log(field('Verify', project.verifyScript));
    }
    console.log('');
  } catch (err) {
    if (err instanceof ProjectNotFoundError) {
      showError(`Project not found: ${projectName}`);
      console.log('');
    } else {
      throw err;
    }
  }
}
