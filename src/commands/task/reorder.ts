import { reorderTask, TaskNotFoundError } from '@src/store/task.ts';
import { SprintStatusError } from '@src/store/sprint.ts';
import { inputPositiveInt, selectTask } from '@src/interactive/selectors.ts';
import { log, showError, showSuccess } from '@src/theme/ui.ts';

export async function taskReorderCommand(args: string[]): Promise<void> {
  let taskId = args[0];
  let newOrder: number | undefined;

  if (args[1]) {
    newOrder = parseInt(args[1], 10);
  }

  // Interactive: select task if not provided
  if (!taskId) {
    const selected = await selectTask('Select task to reorder:');
    if (!selected) return;
    taskId = selected;
  }

  // Interactive: ask for new position if not provided
  if (newOrder === undefined || isNaN(newOrder) || newOrder < 1) {
    newOrder = await inputPositiveInt('New position (1 = highest priority):');
  }

  try {
    const task = await reorderTask(taskId, newOrder);
    showSuccess('Task reordered!', [
      ['ID', task.id],
      ['Name', task.name],
      ['New Order', String(task.order)],
    ]);
    log.newline();
  } catch (err) {
    if (err instanceof TaskNotFoundError) {
      showError(`Task not found: ${taskId}`);
      log.newline();
    } else if (err instanceof SprintStatusError) {
      showError(err.message);
      log.newline();
    } else {
      throw err;
    }
  }
}
