import { confirm } from '@inquirer/prompts';
import { success, muted, error } from '@src/utils/colors.ts';
import { getTask, removeTask, TaskNotFoundError } from '@src/services/task.ts';

export async function taskRemoveCommand(args: string[]): Promise<void> {
  const taskId = args[0];

  if (!taskId) {
    console.log(error('\nTask ID required.'));
    console.log(muted('Usage: ralphctl task remove <task-id>\n'));
    return;
  }

  try {
    const task = await getTask(taskId);

    const confirmed = await confirm({
      message: `Remove task "${task.name}" (${task.id})?`,
      default: false,
    });

    if (!confirmed) {
      console.log(muted('\nTask removal cancelled.\n'));
      return;
    }

    await removeTask(taskId);
    console.log(success(`\nTask ${taskId} removed successfully.\n`));
  } catch (err) {
    if (err instanceof TaskNotFoundError) {
      console.log(error(`\nTask not found: ${taskId}\n`));
    } else {
      throw err;
    }
  }
}
