import { confirm } from '@inquirer/prompts';
import { muted } from '@src/theme/index.ts';
import { deleteSprint, getSprint, SprintNotFoundError } from '@src/store/sprint.ts';
import { listTasks } from '@src/store/task.ts';
import { getCurrentSprint, setCurrentSprint } from '@src/store/config.ts';
import { selectSprint } from '@src/interactive/selectors.ts';
import { formatSprintStatus, log, showError, showRandomQuote, showSuccess, showTip } from '@src/theme/ui.ts';

export async function sprintDeleteCommand(args: string[]): Promise<void> {
  const skipConfirm = args.includes('-y') || args.includes('--yes');
  let sprintId = args.find((a) => !a.startsWith('-'));

  if (!sprintId) {
    const selected = await selectSprint('Select sprint to delete:');
    if (!selected) return;
    sprintId = selected;
  }

  try {
    const sprint = await getSprint(sprintId);

    let taskCount = 0;
    try {
      const tasks = await listTasks(sprintId);
      taskCount = tasks.length;
    } catch {
      // No tasks file
    }

    if (!skipConfirm) {
      log.newline();
      log.warn('This will permanently delete the sprint and all its data.');
      log.item(`Name: ${sprint.name}`);
      log.item(`Status: ${formatSprintStatus(sprint.status)}`);
      log.item(`Tickets: ${String(sprint.tickets.length)}`);
      log.item(`Tasks: ${String(taskCount)}`);
      log.newline();

      const confirmed = await confirm({
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
  } catch (err) {
    if (err instanceof SprintNotFoundError) {
      showError(`Sprint not found: ${sprintId}`);
      log.newline();
    } else {
      throw err;
    }
  }
}
