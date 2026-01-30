import { info, muted, warning } from '@src/utils/colors.ts';
import { getNextTask, formatTaskStatus } from '@src/services/task.ts';

export async function taskNextCommand(): Promise<void> {
  const task = await getNextTask();

  if (!task) {
    console.log(warning('\nNo pending tasks.'));
    console.log(muted('All tasks are done, or add more with: ralphctl task add\n'));
    return;
  }

  console.log(info('\nNext task:\n'));
  console.log(info('  ID:     ') + task.id);
  console.log(info('  Name:   ') + task.name);
  console.log(info('  Status: ') + formatTaskStatus(task.status));
  console.log(info('  Order:  ') + String(task.order));

  if (task.ticketId) {
    console.log(info('  Ticket: ') + task.ticketId);
  }

  if (task.description) {
    console.log(info('\n  Description:'));
    console.log(`    ${task.description}`);
  }

  if (task.steps.length > 0) {
    console.log(info('\n  Steps:'));
    task.steps.forEach((step, i) => {
      console.log(`    ${String(i + 1)}. ${step}`);
    });
  }

  console.log(muted(`\nStart with: ralphctl task status ${task.id} in_progress\n`));
}
