import { info, muted, warning, success } from '@src/utils/colors.ts';
import { getScope, formatScopeStatus, resolveScopeId } from '@src/services/scope.ts';
import { listTasks, formatTaskStatus } from '@src/services/task.ts';
import { getActiveScope } from '@src/services/config.ts';

export async function scopeShowCommand(args: string[]): Promise<void> {
  const scopeId = args[0];

  let id: string;
  try {
    id = await resolveScopeId(scopeId);
  } catch {
    console.log(warning('\nNo scope specified and no active scope set.'));
    console.log(muted('Specify a scope ID or activate one first.\n'));
    return;
  }

  const scope = await getScope(id);
  const tasks = await listTasks(id);
  const activeScopeId = await getActiveScope();
  const isActive = scope.id === activeScopeId;

  console.log(info('\nScope Details:\n'));
  console.log(info('  ID:        ') + scope.id + (isActive ? success(' (active)') : ''));
  console.log(info('  Name:      ') + scope.name);
  console.log(info('  Status:    ') + formatScopeStatus(scope.status));
  console.log(info('  Created:   ') + new Date(scope.createdAt).toLocaleString());

  if (scope.activatedAt) {
    console.log(info('  Activated: ') + new Date(scope.activatedAt).toLocaleString());
  }
  if (scope.closedAt) {
    console.log(info('  Closed:    ') + new Date(scope.closedAt).toLocaleString());
  }

  // Tickets
  console.log(info('\n  Tickets: ') + String(scope.tickets.length));
  for (const ticket of scope.tickets) {
    console.log(`    - ${ticket.id}: ${ticket.title}`);
  }

  // Tasks summary
  const tasksByStatus = {
    todo: tasks.filter((t) => t.status === 'todo').length,
    in_progress: tasks.filter((t) => t.status === 'in_progress').length,
    testing: tasks.filter((t) => t.status === 'testing').length,
    done: tasks.filter((t) => t.status === 'done').length,
  };

  console.log(info('\n  Tasks:'));
  console.log(
    `    ${formatTaskStatus('todo')} ${String(tasksByStatus.todo)}  ` +
      `${formatTaskStatus('in_progress')} ${String(tasksByStatus.in_progress)}  ` +
      `${formatTaskStatus('testing')} ${String(tasksByStatus.testing)}  ` +
      `${formatTaskStatus('done')} ${String(tasksByStatus.done)}`
  );

  // List tasks
  if (tasks.length > 0) {
    console.log('');
    for (const task of tasks) {
      const status = formatTaskStatus(task.status);
      console.log(`    ${String(task.order)}. [${status}] ${task.id}: ${task.name}`);
    }
  }

  console.log('');
}
