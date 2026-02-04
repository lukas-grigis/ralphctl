import { muted } from '@src/theme/index.ts';
import { getSprint, resolveSprintId } from '@src/store/sprint.ts';
import { listTasks } from '@src/store/task.ts';
import { getCurrentSprint } from '@src/store/config.ts';
import { formatTicketDisplay, groupTicketsByProject } from '@src/store/ticket.ts';
import {
  badge,
  field,
  formatSprintStatus,
  formatTaskStatus,
  icons,
  log,
  printCountSummary,
  printHeader,
  printSeparator,
} from '@src/theme/ui.ts';
import { selectSprint } from '@src/interactive/selectors.ts';

export async function sprintShowCommand(args: string[]): Promise<void> {
  const sprintId = args[0];

  let id: string;
  try {
    id = await resolveSprintId(sprintId);
  } catch {
    const selected = await selectSprint('Select sprint to show:');
    if (!selected) return;
    id = selected;
  }

  const sprint = await getSprint(id);
  const tasks = await listTasks(id);
  const currentSprintId = await getCurrentSprint();
  const isCurrent = sprint.id === currentSprintId;

  // Header
  printHeader(sprint.name, icons.sprint);

  // Basic info
  console.log(field('ID', sprint.id + (isCurrent ? ' ' + badge('current', 'success') : '')));
  console.log(field('Status', formatSprintStatus(sprint.status)));
  console.log(field('Created', new Date(sprint.createdAt).toLocaleString()));

  if (sprint.activatedAt) {
    console.log(field('Activated', new Date(sprint.activatedAt).toLocaleString()));
  }
  if (sprint.closedAt) {
    console.log(field('Closed', new Date(sprint.closedAt).toLocaleString()));
  }

  // Tickets section
  log.newline();
  printSeparator();
  log.newline();

  if (sprint.tickets.length === 0) {
    log.dim(`${icons.inactive}  No tickets yet`);
    log.dim(`   ${icons.tip} Add with: ralphctl ticket add`);
  } else {
    log.info(`Tickets (${String(sprint.tickets.length)})`);
    log.newline();

    const ticketsByProject = groupTicketsByProject(sprint.tickets);

    for (const [projectName, tickets] of ticketsByProject) {
      log.raw(`${icons.project}  ${projectName}`, 2);
      for (const ticket of tickets) {
        const specBadge = ticket.specStatus === 'approved' ? badge('approved', 'success') : badge('pending', 'warning');
        log.raw(`${icons.bullet}  ${formatTicketDisplay(ticket)} ${specBadge}`, 3);
      }
      log.newline();
    }
  }

  // Tasks section
  printSeparator();
  log.newline();

  const tasksByStatus = {
    todo: tasks.filter((t) => t.status === 'todo').length,
    in_progress: tasks.filter((t) => t.status === 'in_progress').length,
    done: tasks.filter((t) => t.status === 'done').length,
  };

  if (tasks.length === 0) {
    log.dim(`${icons.inactive}  No tasks yet`);
    log.dim(`   ${icons.tip} Plan with: ralphctl sprint plan`);
  } else {
    log.info(`Tasks`);
    log.newline();

    // Status summary
    log.raw(
      `${formatTaskStatus('todo')} ${String(tasksByStatus.todo)}   ` +
        `${formatTaskStatus('in_progress')} ${String(tasksByStatus.in_progress)}   ` +
        `${formatTaskStatus('done')} ${String(tasksByStatus.done)}`,
      2
    );
    log.newline();

    // Task list
    for (const task of tasks) {
      const statusIcon =
        task.status === 'done' ? icons.success : task.status === 'in_progress' ? icons.active : icons.inactive;
      const statusColor = task.status === 'done' ? 'success' : task.status === 'in_progress' ? 'warning' : 'muted';
      log.raw(`${muted(String(task.order) + '.')} ${badge(statusIcon, statusColor)} ${task.name}`, 2);
    }

    // Summary
    printCountSummary('Progress', tasksByStatus.done, tasks.length);
  }

  log.newline();
}
