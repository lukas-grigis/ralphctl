import { colors, muted } from '@src/theme/index.ts';
import { listTasks } from '@src/store/task.ts';
import { badge, formatTaskStatus, icons, log, printHeader, showEmpty } from '@src/theme/ui.ts';

export async function taskListCommand(args: string[] = []): Promise<void> {
  const brief = args.includes('-b') || args.includes('--brief');
  const tasks = await listTasks();

  if (tasks.length === 0) {
    showEmpty('tasks', 'Add one with: ralphctl task add');
    return;
  }

  if (brief) {
    // Brief mode: one line per task
    console.log(`\n# Tasks (${String(tasks.length)})\n`);
    for (const task of tasks) {
      const ticketRef = task.ticketId ? ` [${task.ticketId}]` : '';
      const blockedRef = task.blockedBy.length > 0 ? ` (blocked by: ${task.blockedBy.join(', ')})` : '';
      console.log(
        `- ${String(task.order)}. **[${task.status}]** ${task.id}: ${task.name} (${task.projectPath})${ticketRef}${blockedRef}`
      );
    }
    console.log('');
    return;
  }

  // Interactive list with status icons and alignment
  const tasksByStatus = {
    todo: tasks.filter((t) => t.status === 'todo').length,
    in_progress: tasks.filter((t) => t.status === 'in_progress').length,
    done: tasks.filter((t) => t.status === 'done').length,
  };

  printHeader(`Tasks (${String(tasks.length)})`, icons.task);

  // Status summary
  log.raw(
    `${formatTaskStatus('todo')} ${String(tasksByStatus.todo)}   ` +
      `${formatTaskStatus('in_progress')} ${String(tasksByStatus.in_progress)}   ` +
      `${formatTaskStatus('done')} ${String(tasksByStatus.done)}`
  );
  log.newline();

  const ORDER_W = String(tasks.length).length + 1;

  for (const task of tasks) {
    const statusIcon =
      task.status === 'done' ? icons.success : task.status === 'in_progress' ? icons.active : icons.inactive;
    const statusColor = task.status === 'done' ? 'success' : task.status === 'in_progress' ? 'warning' : 'muted';
    const order = muted(String(task.order).padStart(ORDER_W) + '.');
    const ticketRef = task.ticketId ? ' ' + muted(`[${task.ticketId}]`) : '';
    const blockedRef = task.blockedBy.length > 0 ? ' ' + colors.error(`(blocked)`) : '';

    log.raw(`${order} ${badge(statusIcon, statusColor)} ${task.name} ${muted(task.id)}${ticketRef}${blockedRef}`);
  }

  // Progress summary
  const percent = tasks.length > 0 ? Math.round((tasksByStatus.done / tasks.length) * 100) : 0;
  const progressColor = percent === 100 ? colors.success : percent > 50 ? colors.warning : colors.muted;
  log.newline();
  log.dim(`Progress: ${progressColor(`${String(tasksByStatus.done)}/${String(tasks.length)} (${String(percent)}%)`)}`);
  log.newline();
}
