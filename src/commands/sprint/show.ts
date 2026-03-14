import { wrapAsync } from '@src/utils/result-helpers.ts';
import { colors, muted } from '@src/theme/index.ts';
import { getSprint, resolveSprintId } from '@src/store/sprint.ts';
import { listTasks } from '@src/store/task.ts';
import { getCurrentSprint } from '@src/store/config.ts';
import { formatTicketDisplay, getPendingRequirements, groupTicketsByProject } from '@src/store/ticket.ts';
import {
  badge,
  formatSprintStatus,
  formatTaskStatus,
  horizontalLine,
  icons,
  labelValue,
  log,
  printCountSummary,
  renderCard,
  showNextStep,
} from '@src/theme/ui.ts';
import { selectSprint } from '@src/interactive/selectors.ts';

export async function sprintShowCommand(args: string[]): Promise<void> {
  const sprintId = args[0];

  let id: string;
  const idR = await wrapAsync(
    () => resolveSprintId(sprintId),
    (err) => (err instanceof Error ? err : new Error(String(err)))
  );
  if (!idR.ok) {
    const selected = await selectSprint('Select sprint to show:');
    if (!selected) return;
    id = selected;
  } else {
    id = idR.value;
  }

  const sprint = await getSprint(id);
  const tasks = await listTasks(id);
  const currentSprintId = await getCurrentSprint();
  const isCurrent = sprint.id === currentSprintId;

  // Sprint info card
  const infoLines: string[] = [
    labelValue('ID', sprint.id + (isCurrent ? ' ' + badge('current', 'success') : '')),
    labelValue('Status', formatSprintStatus(sprint.status)),
    labelValue('Created', new Date(sprint.createdAt).toLocaleString()),
  ];
  if (sprint.activatedAt) {
    infoLines.push(labelValue('Activated', new Date(sprint.activatedAt).toLocaleString()));
  }
  if (sprint.closedAt) {
    infoLines.push(labelValue('Closed', new Date(sprint.closedAt).toLocaleString()));
  }
  if (sprint.branch) {
    infoLines.push(labelValue('Branch', sprint.branch));
  }

  log.newline();
  console.log(renderCard(`${icons.sprint} ${sprint.name}`, infoLines));

  // Tickets card
  log.newline();
  const ticketLines: string[] = [];

  if (sprint.tickets.length === 0) {
    ticketLines.push(muted('No tickets yet'));
    ticketLines.push(muted(`${icons.tip} Add with: ralphctl ticket add`));
  } else {
    const ticketsByProject = groupTicketsByProject(sprint.tickets);
    let first = true;
    for (const [projectName, tickets] of ticketsByProject) {
      if (!first) ticketLines.push('');
      first = false;
      ticketLines.push(`${colors.info(icons.project)} ${colors.info(projectName)}`);
      for (const ticket of tickets) {
        const reqBadge =
          ticket.requirementStatus === 'approved' ? badge('approved', 'success') : badge('pending', 'warning');
        ticketLines.push(`  ${icons.bullet} ${formatTicketDisplay(ticket)} ${reqBadge}`);
      }
    }
  }

  console.log(renderCard(`${icons.ticket} Tickets (${String(sprint.tickets.length)})`, ticketLines));

  // Tasks card
  log.newline();
  const taskLines: string[] = [];

  const tasksByStatus = {
    todo: tasks.filter((t) => t.status === 'todo').length,
    in_progress: tasks.filter((t) => t.status === 'in_progress').length,
    done: tasks.filter((t) => t.status === 'done').length,
  };

  if (tasks.length === 0) {
    taskLines.push(muted('No tasks yet'));
    taskLines.push(muted(`${icons.tip} Plan with: ralphctl sprint plan`));
  } else {
    // Status summary row
    taskLines.push(
      `${formatTaskStatus('todo')} ${String(tasksByStatus.todo)}   ` +
        `${formatTaskStatus('in_progress')} ${String(tasksByStatus.in_progress)}   ` +
        `${formatTaskStatus('done')} ${String(tasksByStatus.done)}`
    );
    taskLines.push(colors.muted(horizontalLine(40, 'rounded')));

    // Task list
    for (const task of tasks) {
      const statusIcon =
        task.status === 'done' ? icons.success : task.status === 'in_progress' ? icons.active : icons.inactive;
      const statusColor = task.status === 'done' ? 'success' : task.status === 'in_progress' ? 'warning' : 'muted';
      taskLines.push(`${muted(String(task.order) + '.')} ${badge(statusIcon, statusColor)} ${task.name}`);
    }
  }

  console.log(renderCard(`${icons.task} Tasks (${String(tasks.length)})`, taskLines));

  // Progress summary (outside card for consistent formatting)
  if (tasks.length > 0) {
    printCountSummary('Progress', tasksByStatus.done, tasks.length);
  }

  // State-aware next steps
  log.newline();
  if (sprint.status === 'draft') {
    const pendingCount = getPendingRequirements(sprint.tickets).length;
    if (sprint.tickets.length === 0) {
      showNextStep('ralphctl ticket add --project <name>', 'add tickets to this sprint');
    } else if (pendingCount > 0) {
      showNextStep('ralphctl sprint refine', 'refine ticket requirements');
    } else if (tasks.length === 0) {
      showNextStep('ralphctl sprint plan', 'generate tasks from tickets');
    } else {
      showNextStep('ralphctl sprint start', 'begin implementation');
    }
  } else if (sprint.status === 'active') {
    if (tasksByStatus.done === tasks.length && tasks.length > 0) {
      showNextStep('ralphctl sprint close', 'all tasks done — close the sprint');
    } else {
      showNextStep('ralphctl sprint start', 'continue implementation');
    }
  }

  log.newline();
}
