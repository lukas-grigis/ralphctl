import { getPrompt } from '@src/application/bootstrap.ts';
import {
  emoji,
  field,
  formatSprintStatus,
  icons,
  showError,
  showNextStep,
  showRandomQuote,
  showSuccess,
} from '@src/integration/ui/theme/ui.ts';
import { setCurrentSprint } from '@src/integration/persistence/config.ts';
import { createSprint } from '@src/integration/persistence/sprint.ts';
import { listProjects } from '@src/integration/persistence/project.ts';
import { EXIT_ERROR, exitWithCode } from '@src/application/exit-codes.ts';

interface SprintCreateOptions {
  name?: string;
  project?: string;
  interactive?: boolean;
}

export async function sprintCreateCommand(options: SprintCreateOptions = {}): Promise<void> {
  const projects = await listProjects();
  if (projects.length === 0) {
    showError('No projects configured.');
    showNextStep('ralphctl project add', 'add a project first');
    if (options.interactive === false) exitWithCode(EXIT_ERROR);
    return;
  }

  // Resolve project — required
  let projectId: string | undefined;
  const projectFlag = options.project?.trim();
  if (projectFlag) {
    const match = projects.find((p) => p.name === projectFlag || p.id === projectFlag);
    if (!match) {
      showError(`Project not found: ${projectFlag}`);
      if (options.interactive === false) exitWithCode(EXIT_ERROR);
      return;
    }
    projectId = match.id;
  } else if (options.interactive === false) {
    showError('--project is required in non-interactive mode');
    exitWithCode(EXIT_ERROR);
  } else if (projects.length === 1 && projects[0]) {
    projectId = projects[0].id;
  } else {
    projectId = await getPrompt().select<string>({
      message: `${icons.project} Project:`,
      choices: projects.map((p) => ({ label: p.displayName, value: p.id, description: p.description })),
    });
  }

  if (!projectId) {
    showError('No project selected.');
    return;
  }

  const pickedProject = projects.find((p) => p.id === projectId);

  let name: string | undefined;
  if (options.interactive === false) {
    const trimmed = options.name?.trim();
    name = trimmed && trimmed.length > 0 ? trimmed : undefined;
  } else {
    const inputName = await getPrompt().input({
      message: `${icons.sprint} Sprint name (optional):`,
      default: options.name?.trim(),
    });
    const trimmed = inputName.trim();
    name = trimmed.length > 0 ? trimmed : undefined;
  }

  const sprint = await createSprint({ projectId, name });

  let setAsCurrent = true;
  if (options.interactive) {
    setAsCurrent = await getPrompt().confirm({
      message: `${emoji.donut} Set as current sprint?`,
      default: true,
    });
  }

  if (setAsCurrent) {
    await setCurrentSprint(sprint.id);
  }

  showSuccess('Sprint created!', [
    ['ID', sprint.id],
    ['Name', sprint.name],
    ['Project', pickedProject ? `${pickedProject.displayName} (${pickedProject.name})` : projectId],
    ['Status', formatSprintStatus(sprint.status)],
  ]);
  showRandomQuote();

  if (setAsCurrent) {
    console.log(field('Current', 'Yes (this sprint is now active target)'));
    showNextStep('ralphctl ticket add', 'add tickets to this sprint');
  } else {
    console.log(field('Current', 'No'));
    showNextStep(`ralphctl sprint current ${sprint.id}`, 'set as current later');
  }
}
