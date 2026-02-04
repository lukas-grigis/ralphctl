import { listTasks } from '@src/store/task.ts';
import { showEmpty } from '@src/theme/ui.ts';

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

  // Full markdown format optimized for LLM readability
  console.log(`\n# Tasks (${String(tasks.length)})\n`);

  for (const task of tasks) {
    const ticketRef = task.ticketId ? ` (Ticket: ${task.ticketId})` : '';
    console.log(`## ${String(task.order)}. [${task.status}] ${task.name}${ticketRef}\n`);
    console.log(`**ID:** ${task.id}\n`);
    console.log(`**Project:** ${task.projectPath}\n`);

    if (task.description) {
      console.log('### Description\n');
      console.log(task.description);
      console.log('');
    }

    if (task.steps.length > 0) {
      console.log('### Steps\n');
      task.steps.forEach((step, i) => {
        console.log(`${String(i + 1)}. ${step}`);
      });
      console.log('');
    }

    if (task.blockedBy.length > 0) {
      console.log('### Blocked By\n');
      task.blockedBy.forEach((dep) => {
        console.log(`- ${dep}`);
      });
      console.log('');
    }

    console.log('---\n');
  }
}
