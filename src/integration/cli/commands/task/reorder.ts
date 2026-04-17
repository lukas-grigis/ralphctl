import { ensureError, wrapAsync } from '@src/integration/utils/result-helpers.ts';
import { reorderTask, TaskNotFoundError } from '@src/integration/persistence/task.ts';
import { SprintStatusError } from '@src/integration/persistence/sprint.ts';
import { inputPositiveInt, selectTask } from '@src/integration/cli/commands/shared/selectors.ts';
import { log, showError, showSuccess } from '@src/integration/ui/theme/ui.ts';

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

  const reorderR = await wrapAsync(() => reorderTask(taskId, newOrder), ensureError);
  if (!reorderR.ok) {
    if (reorderR.error instanceof TaskNotFoundError) {
      showError(`Task not found: ${taskId}`);
      log.newline();
    } else if (reorderR.error instanceof SprintStatusError) {
      showError(reorderR.error.message);
      log.newline();
    } else {
      throw reorderR.error;
    }
    return;
  }

  showSuccess('Task reordered!', [
    ['ID', reorderR.value.id],
    ['Name', reorderR.value.name],
    ['New Order', String(reorderR.value.order)],
  ]);
  log.newline();
}
