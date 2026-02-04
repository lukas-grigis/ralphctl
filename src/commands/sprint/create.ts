import { confirm, input } from '@inquirer/prompts';
import { error } from '@src/theme/index.ts';
import { emoji, field, formatSprintStatus, icons, showError, showNextStep, showSuccess } from '@src/theme/ui.ts';
import { setCurrentSprint } from '@src/store/config.ts';
import { createSprint } from '@src/store/sprint.ts';

export interface SprintCreateOptions {
  name?: string;
  interactive?: boolean; // Set by REPL or CLI (default true unless --no-interactive)
}

export async function sprintCreateCommand(options: SprintCreateOptions = {}): Promise<void> {
  let name: string | undefined;

  if (options.interactive === false) {
    // Non-interactive: name is optional (will generate uuid8 if not provided)
    name = options.name?.trim() || undefined;
  } else {
    // Interactive mode: prompt for name (can be left empty)
    const inputName = await input({
      message: `${icons.sprint} Sprint name (optional):`,
      default: options.name?.trim(),
    });
    name = inputName.trim() || undefined;
  }

  // Create sprint (as draft) - name is optional, will generate uuid8 if empty
  const sprint = await createSprint(name);

  // Ask if user wants to set as current sprint
  let setAsCurrent = true;

  if (options.interactive) {
    setAsCurrent = await confirm({
      message: `${emoji.donut} Set as current sprint?`,
      default: true,
    });
  }
  // In non-interactive mode, default to setting as current

  if (setAsCurrent) {
    await setCurrentSprint(sprint.id);
  }

  showSuccess('Sprint created!', [
    ['ID', sprint.id],
    ['Name', sprint.name],
    ['Status', formatSprintStatus(sprint.status)],
  ]);

  if (setAsCurrent) {
    console.log(field('Current', 'Yes (this sprint is now active target)'));
    showNextStep('ralphctl ticket add --project <name>', 'add tickets to this sprint');
  } else {
    console.log(field('Current', 'No'));
    showNextStep(`ralphctl sprint current ${sprint.id}`, 'set as current later');
  }
}
