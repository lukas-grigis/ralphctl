import { getTask, TaskNotFoundError } from '@src/store/task.ts';
import { field, formatTaskStatus, log, printHeader, showError } from '@src/theme/ui.ts';
import { selectTask } from '@src/interactive/selectors.ts';

export async function taskShowCommand(args: string[]): Promise<void> {
  let taskId = args[0];

  if (!taskId) {
    const selected = await selectTask('Select task to show:');
    if (!selected) return;
    taskId = selected;
  }

  try {
    const task = await getTask(taskId);

    printHeader('Task Details');
    console.log(field('ID', task.id));
    console.log(field('Name', task.name));
    console.log(field('Status', formatTaskStatus(task.status)));
    console.log(field('Order', String(task.order)));
    console.log(field('Project', task.projectPath));

    if (task.ticketId) {
      console.log(field('Ticket', task.ticketId));
    }

    if (task.description) {
      console.log(field('Description', task.description));
    }

    if (task.steps.length > 0) {
      log.newline();
      console.log(field('Steps', ''));
      task.steps.forEach((step, i) => {
        log.raw(`${String(i + 1)}. ${step}`, 2);
      });
    }

    log.newline();
  } catch (err) {
    if (err instanceof TaskNotFoundError) {
      showError(`Task not found: ${taskId}`);
      log.newline();
    } else {
      throw err;
    }
  }
}
