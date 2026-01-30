import { muted, warning } from '@src/utils/colors.ts';
import { getScope, resolveScopeId } from '@src/services/scope.ts';
import { listTasks } from '@src/services/task.ts';

export async function scopeContextCommand(args: string[]): Promise<void> {
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

  // Output in a format useful for Claude
  console.log(`# Scope: ${scope.name}`);
  console.log(`ID: ${scope.id}`);
  console.log(`Status: ${scope.status}`);
  console.log('');

  // Tickets section
  console.log('## Tickets');
  console.log('');
  if (scope.tickets.length === 0) {
    console.log('_No tickets defined_');
  } else {
    for (const ticket of scope.tickets) {
      console.log(`### ${ticket.id}: ${ticket.title}`);
      if (ticket.description) {
        console.log('');
        console.log(ticket.description);
      }
      if (ticket.link) {
        console.log('');
        console.log(`Link: ${ticket.link}`);
      }
      console.log('');
    }
  }

  // Tasks section
  console.log('## Tasks');
  console.log('');
  if (tasks.length === 0) {
    console.log('_No tasks defined yet_');
  } else {
    for (const task of tasks) {
      const ticketRef = task.ticketId ? ` [${task.ticketId}]` : '';
      console.log(`### ${task.id}: ${task.name}${ticketRef}`);
      console.log(`Status: ${task.status} | Order: ${String(task.order)}`);
      if (task.description) {
        console.log('');
        console.log(task.description);
      }
      if (task.steps.length > 0) {
        console.log('');
        console.log('Steps:');
        task.steps.forEach((step, i) => {
          console.log(`${String(i + 1)}. ${step}`);
        });
      }
      console.log('');
    }
  }
}
