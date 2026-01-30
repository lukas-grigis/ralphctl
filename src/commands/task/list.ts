import { info, muted, warning } from '@src/utils/colors.ts';
import { listTasks, formatTaskStatus } from '@src/services/task.ts';

export async function taskListCommand(): Promise<void> {
  const tasks = await listTasks();

  if (tasks.length === 0) {
    console.log(warning('\nNo tasks found in the active scope.'));
    console.log(muted('Add one with: ralphctl task add\n'));
    return;
  }

  console.log(info('\nTasks:\n'));

  for (const task of tasks) {
    const status = formatTaskStatus(task.status);
    const ticketRef = task.ticketId ? ` [${task.ticketId}]` : '';
    console.log(`  ${String(task.order)}. [${status}] ${task.id}: ${task.name}${ticketRef}`);
  }

  console.log('');
}
