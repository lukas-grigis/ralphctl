import { info, muted, error } from '@src/utils/colors.ts';
import { getTask, formatTaskStatus, TaskNotFoundError } from '@src/services/task.ts';

export async function taskShowCommand(args: string[]): Promise<void> {
  const taskId = args[0];

  if (!taskId) {
    console.log(error('\nTask ID required.'));
    console.log(muted('Usage: ralphctl task show <task-id>\n'));
    return;
  }

  try {
    const task = await getTask(taskId);

    console.log(info('\nTask Details:\n'));
    console.log(info('  ID:          ') + task.id);
    console.log(info('  Name:        ') + task.name);
    console.log(info('  Status:      ') + formatTaskStatus(task.status));
    console.log(info('  Order:       ') + String(task.order));

    if (task.ticketId) {
      console.log(info('  Ticket:      ') + task.ticketId);
    }

    if (task.description) {
      console.log(info('  Description: ') + task.description);
    }

    if (task.steps.length > 0) {
      console.log(info('\n  Steps:'));
      task.steps.forEach((step, i) => {
        console.log(`    ${String(i + 1)}. ${step}`);
      });
    }

    console.log('');
  } catch (err) {
    if (err instanceof TaskNotFoundError) {
      console.log(error(`\nTask not found: ${taskId}\n`));
    } else {
      throw err;
    }
  }
}
