import { ensureError, wrapAsync } from '@src/utils/result-helpers.ts';
import { getCurrentSprint, setCurrentSprint } from '@src/store/config.ts';
import { getSprint, SprintNotFoundError } from '@src/store/sprint.ts';
import { selectSprint } from '@src/interactive/selectors.ts';
import {
  field,
  formatSprintStatus,
  log,
  printHeader,
  showError,
  showNextStep,
  showSuccess,
  showWarning,
} from '@src/theme/ui.ts';

export async function sprintCurrentCommand(args: string[]): Promise<void> {
  const sprintId = args[0];

  if (!sprintId) {
    // Show current sprint
    const currentSprintId = await getCurrentSprint();
    if (!currentSprintId) {
      showWarning('No current sprint set.');
      showNextStep('ralphctl sprint create', 'create a new sprint');
      log.newline();
      return;
    }

    const sprintR = await wrapAsync(() => getSprint(currentSprintId), ensureError);
    if (sprintR.ok) {
      printHeader('Current Sprint');
      console.log(field('ID', sprintR.value.id));
      console.log(field('Name', sprintR.value.name));
      console.log(field('Status', formatSprintStatus(sprintR.value.status)));
      log.newline();
    } else {
      showWarning(`Current sprint "${currentSprintId}" no longer exists.`);
      showNextStep('ralphctl sprint current -', 'select a different sprint');
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
    const setR = await wrapAsync(async () => {
      const sprint = await getSprint(sprintId);
      await setCurrentSprint(sprintId);
      return sprint;
    }, ensureError);
    if (setR.ok) {
      showSuccess('Current sprint set!', [
        ['ID', setR.value.id],
        ['Name', setR.value.name],
      ]);
      log.newline();
    } else if (setR.error instanceof SprintNotFoundError) {
      showError(`Sprint not found: ${sprintId}`);
      showNextStep('ralphctl sprint list', 'see available sprints');
      log.newline();
    } else {
      throw setR.error;
    }
  }
}
