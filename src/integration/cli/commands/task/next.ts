import { getNextTask } from '@src/integration/persistence/task.ts';
import { field, formatTaskStatus, log, printHeader, showEmpty, showNextStep } from '@src/integration/ui/theme/ui.ts';

export async function taskNextCommand(): Promise<void> {
  const task = await getNextTask();

  if (!task) {
    showEmpty('pending tasks', 'All tasks are done, or add more with: ralphctl task add');
    return;
  }

  printHeader('Next Task');
  console.log(field('ID', task.id));
  console.log(field('Name', task.name));
  console.log(field('Status', formatTaskStatus(task.status)));
  console.log(field('Order', String(task.order)));

  if (task.ticketId) {
    console.log(field('Ticket', task.ticketId));
  }

  if (task.description) {
    log.newline();
    console.log(field('Description', ''));
    log.raw(task.description, 2);
  }

  if (task.steps.length > 0) {
    log.newline();
    console.log(field('Steps', ''));
    task.steps.forEach((step, i) => {
      log.raw(`${String(i + 1)}. ${step}`, 2);
    });
  }

  if (task.blockedBy.length > 0) {
    log.newline();
    console.log(field('Blocked By', ''));
    task.blockedBy.forEach((dep) => {
      log.item(dep);
    });
  }

  showNextStep(`ralphctl task status ${task.id} in_progress`, 'Start working on this task');
}
