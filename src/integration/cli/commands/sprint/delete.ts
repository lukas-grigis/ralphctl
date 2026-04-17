import { getPrompt } from '@src/application/bootstrap.ts';
import { ensureError, wrapAsync } from '@src/integration/utils/result-helpers.ts';
import { muted } from '@src/integration/ui/theme/theme.ts';
import { deleteSprint, getSprint, SprintNotFoundError } from '@src/integration/persistence/sprint.ts';
import { listTasks } from '@src/integration/persistence/task.ts';
import { getCurrentSprint, setCurrentSprint } from '@src/integration/persistence/config.ts';
import { selectSprint } from '@src/integration/cli/commands/shared/selectors.ts';
import {
  formatSprintStatus,
  log,
  showError,
  showRandomQuote,
  showSuccess,
  showTip,
} from '@src/integration/ui/theme/ui.ts';

export async function sprintDeleteCommand(args: string[]): Promise<void> {
  const skipConfirm = args.includes('-y') || args.includes('--yes');
  let sprintId = args.find((a) => !a.startsWith('-'));

  if (!sprintId) {
    const selected = await selectSprint('Select sprint to delete:');
    if (!selected) return;
    sprintId = selected;
  }

  const sprintR = await wrapAsync(() => getSprint(sprintId), ensureError);
  if (!sprintR.ok) {
    if (sprintR.error instanceof SprintNotFoundError) {
      showError(`Sprint not found: ${sprintId}`);
      log.newline();
    } else {
      throw sprintR.error;
    }
    return;
  }
  const sprint = sprintR.value;

  let taskCount = 0;
  const tasksR = await wrapAsync(() => listTasks(sprintId), ensureError);
  if (tasksR.ok) {
    taskCount = tasksR.value.length;
  }

  if (!skipConfirm) {
    log.newline();
    log.warn('This will permanently delete the sprint and all its data.');
    log.item(`Name: ${sprint.name}`);
    log.item(`Status: ${formatSprintStatus(sprint.status)}`);
    log.item(`Tickets: ${String(sprint.tickets.length)}`);
    log.item(`Tasks: ${String(taskCount)}`);
    log.newline();

    const confirmed = await getPrompt().confirm({
      message: `Delete sprint "${sprint.name}"?`,
      default: false,
    });

    if (!confirmed) {
      console.log(muted('\nSprint deletion cancelled.\n'));
      return;
    }
  }

  const currentSprintId = await getCurrentSprint();
  await deleteSprint(sprintId);

  if (currentSprintId === sprintId) {
    await setCurrentSprint(null);
    showTip('Current sprint was cleared. Use "ralphctl sprint current" to set a new one.');
  }

  showSuccess('Sprint deleted', [
    ['Name', sprint.name],
    ['ID', sprint.id],
  ]);
  showRandomQuote();
  log.newline();
}
