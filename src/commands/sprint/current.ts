import { getCurrentSprint, setCurrentSprint } from '@src/store/config.ts';
import { getSprint, SprintNotFoundError } from '@src/store/sprint.ts';
import { selectSprint } from '@src/interactive/selectors.ts';
import { field, formatSprintStatus, log, printHeader, showError, showSuccess, showWarning } from '@src/theme/ui.ts';

export async function sprintCurrentCommand(args: string[]): Promise<void> {
  const sprintId = args[0];

  if (!sprintId) {
    // Show current sprint
    const currentSprintId = await getCurrentSprint();
    if (!currentSprintId) {
      showWarning('No current sprint set.');
      log.dim('Create one with: ralphctl sprint create');
      log.newline();
      return;
    }

    try {
      const sprint = await getSprint(currentSprintId);
      printHeader('Current Sprint');
      console.log(field('ID', sprint.id));
      console.log(field('Name', sprint.name));
      console.log(field('Status', formatSprintStatus(sprint.status)));
      log.newline();
    } catch {
      showWarning(`Current sprint "${currentSprintId}" no longer exists.`);
      log.dim('Set a new one with: ralphctl sprint current <id>');
      log.newline();
    }
    return;
  }

  // Set current sprint
  if (sprintId === '-' || sprintId === '--select') {
    const selectedId = await selectSprint('Select current sprint:', ['draft', 'active']);
    if (!selectedId) return;

    await setCurrentSprint(selectedId);
    const sprint = await getSprint(selectedId);
    showSuccess('Current sprint set!', [
      ['ID', sprint.id],
      ['Name', sprint.name],
    ]);
    log.newline();
  } else {
    // Set by ID
    try {
      const sprint = await getSprint(sprintId);
      await setCurrentSprint(sprintId);
      showSuccess('Current sprint set!', [
        ['ID', sprint.id],
        ['Name', sprint.name],
      ]);
      log.newline();
    } catch (err) {
      if (err instanceof SprintNotFoundError) {
        showError(`Sprint not found: ${sprintId}`);
        log.newline();
      } else {
        throw err;
      }
    }
  }
}
