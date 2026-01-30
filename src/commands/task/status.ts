import { success, muted, error, info } from '@src/utils/colors.ts';
import {
  updateTaskStatus,
  formatTaskStatus,
  TaskNotFoundError,
} from '@src/services/task.ts';
import { TaskStatusSchema, type TaskStatus } from '@src/schemas/index.ts';

const VALID_STATUSES: TaskStatus[] = ['todo', 'in_progress', 'testing', 'done'];

export async function taskStatusCommand(args: string[]): Promise<void> {
  const taskId = args[0];
  const newStatus = args[1];

  if (!taskId || !newStatus) {
    console.log(error('\nTask ID and status required.'));
    console.log(muted('Usage: ralphctl task status <task-id> <status>'));
    console.log(muted(`Valid statuses: ${VALID_STATUSES.join(', ')}\n`));
    return;
  }

  const result = TaskStatusSchema.safeParse(newStatus);
  if (!result.success) {
    console.log(error(`\nInvalid status: ${newStatus}`));
    console.log(muted(`Valid statuses: ${VALID_STATUSES.join(', ')}\n`));
    return;
  }

  try {
    const task = await updateTaskStatus(taskId, result.data);
    console.log(success('\nTask status updated!'));
    console.log(info('  ID:     ') + task.id);
    console.log(info('  Name:   ') + task.name);
    console.log(info('  Status: ') + formatTaskStatus(task.status));
    console.log('');
  } catch (err) {
    if (err instanceof TaskNotFoundError) {
      console.log(error(`\nTask not found: ${taskId}\n`));
    } else {
      throw err;
    }
  }
}
