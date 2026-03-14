import { confirm } from '@inquirer/prompts';
import { ensureError, wrapAsync } from '@src/utils/result-helpers.ts';
import { muted } from '@src/theme/index.ts';
import { getProject, ProjectNotFoundError, removeProject } from '@src/store/project.ts';
import { selectProject } from '@src/interactive/selectors.ts';
import { showError, showSuccess } from '@src/theme/ui.ts';

export async function projectRemoveCommand(args: string[]): Promise<void> {
  const skipConfirm = args.includes('-y') || args.includes('--yes');
  let projectName = args.find((a) => !a.startsWith('-'));

  if (!projectName) {
    const selected = await selectProject('Select project to remove:');
    if (!selected) return;
    projectName = selected;
  }

  const projectR = await wrapAsync(() => getProject(projectName), ensureError);
  if (!projectR.ok) {
    if (projectR.error instanceof ProjectNotFoundError) {
      showError(`Project not found: ${projectName}`);
      console.log('');
    } else {
      throw projectR.error;
    }
    return;
  }
  const project = projectR.value;

  if (!skipConfirm) {
    const confirmed = await confirm({
      message: `Remove project "${project.displayName}" (${project.name})?`,
      default: false,
    });

    if (!confirmed) {
      console.log(muted('\nProject removal cancelled.\n'));
      return;
    }
  }

  await removeProject(projectName);
  showSuccess('Project removed', [['Name', projectName]]);
  console.log('');
}
