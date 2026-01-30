import { success, muted, error, info } from '@src/utils/colors.ts';
import { reorderTask, TaskNotFoundError } from '@src/services/task.ts';

export async function taskReorderCommand(args: string[]): Promise<void> {
  const taskId = args[0];
  const newOrderStr = args[1];

  if (!taskId || !newOrderStr) {
    console.log(error('\nTask ID and new order required.'));
    console.log(muted('Usage: ralphctl task reorder <task-id> <new-order>\n'));
    return;
  }

  const newOrder = parseInt(newOrderStr, 10);
  if (isNaN(newOrder) || newOrder < 1) {
    console.log(error('\nOrder must be a positive integer.\n'));
    return;
  }

  try {
    const task = await reorderTask(taskId, newOrder);
    console.log(success('\nTask reordered!'));
    console.log(info('  ID:        ') + task.id);
    console.log(info('  Name:      ') + task.name);
    console.log(info('  New Order: ') + String(task.order));
    console.log('');
  } catch (err) {
    if (err instanceof TaskNotFoundError) {
      console.log(error(`\nTask not found: ${taskId}\n`));
    } else {
      throw err;
    }
  }
}
