import { confirm } from '@inquirer/prompts';
import { muted } from '@src/theme/index.ts';
import { closeSprint, listSprints, SprintNotFoundError, SprintStatusError } from '@src/store/sprint.ts';
import { areAllTasksDone, listTasks } from '@src/store/task.ts';
import { selectSprint } from '@src/interactive/selectors.ts';
import { formatSprintStatus, log, showError, showSuccess, showWarning } from '@src/theme/ui.ts';

export async function sprintCloseCommand(args: string[]): Promise<void> {
  let sprintId: string;

  // If explicit ID provided, use it
  if (args[0]) {
    sprintId = args[0];
  } else {
    // Check active sprints - show selector if multiple, auto-select if one
    const sprints = await listSprints();
    const activeSprints = sprints.filter((s) => s.status === 'active');

    if (activeSprints.length === 0) {
      showError('No active sprints to close.');
      log.newline();
      return;
    } else if (activeSprints.length === 1 && activeSprints[0]) {
      sprintId = activeSprints[0].id;
    } else {
      const selected = await selectSprint('Select sprint to close:', ['active']);
      if (!selected) return;
      sprintId = selected;
    }
  }

  // Check if all tasks are done
  const allDone = await areAllTasksDone(sprintId);
  if (!allDone) {
    const tasks = await listTasks(sprintId);
    const remaining = tasks.filter((t) => t.status !== 'done');
    log.newline();
    showWarning(`${String(remaining.length)} task(s) are not done:`);
    for (const task of remaining) {
      log.item(`${task.id}: ${task.name} (${task.status})`);
    }
    log.newline();

    const proceed = await confirm({
      message: 'Close sprint anyway?',
      default: false,
    });

    if (!proceed) {
      console.log(muted('\nSprint close cancelled.\n'));
      return;
    }
  }

  try {
    const sprint = await closeSprint(sprintId);
    showSuccess('Sprint closed!', [
      ['ID', sprint.id],
      ['Name', sprint.name],
      ['Status', formatSprintStatus(sprint.status)],
    ]);
    log.newline();
    log.dim('The sprint has been archived.');
    log.newline();
  } catch (err) {
    if (err instanceof SprintNotFoundError) {
      showError(`Sprint not found: ${sprintId}`);
      log.newline();
    } else if (err instanceof SprintStatusError) {
      showError(err.message);
      log.newline();
    } else {
      throw err;
    }
  }
}
