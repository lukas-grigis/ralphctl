import { colors, muted } from '@src/theme/index.ts';
import { getSprint, resolveSprintId } from '@src/store/sprint.ts';
import { listTasks } from '@src/store/task.ts';
import { getCurrentSprint } from '@src/store/config.ts';
import { formatTicketDisplay, groupTicketsByProject } from '@src/store/ticket.ts';
import {
  badge,
  boxChars,
  DETAIL_LABEL_WIDTH,
  formatSprintStatus,
  formatTaskStatus,
  icons,
  log,
  renderCard,
  showNextStep,
} from '@src/theme/ui.ts';
import { selectSprint } from '@src/interactive/selectors.ts';

const LABEL_W = DETAIL_LABEL_WIDTH;

function labelValue(label: string, value: string): string {
  const paddedLabel = (label + ':').padEnd(LABEL_W);
  return `${colors.muted(paddedLabel)} ${value}`;
}

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
    taskLines.push(colors.muted(boxChars.light.horizontal.repeat(40)));

    // Task list
    for (const task of tasks) {
      const statusIcon =
        task.status === 'done' ? icons.success : task.status === 'in_progress' ? icons.active : icons.inactive;
      const statusColor = task.status === 'done' ? 'success' : task.status === 'in_progress' ? 'warning' : 'muted';
      taskLines.push(`${muted(String(task.order) + '.')} ${badge(statusIcon, statusColor)} ${task.name}`);
    }

    // Progress
    const percent = tasks.length > 0 ? Math.round((tasksByStatus.done / tasks.length) * 100) : 0;
    const progressColor = percent === 100 ? colors.success : percent > 50 ? colors.warning : colors.muted;
    taskLines.push(colors.muted(boxChars.light.horizontal.repeat(40)));
    taskLines.push(
      `${muted('Progress:')}  ${progressColor(`${String(tasksByStatus.done)}/${String(tasks.length)} (${String(percent)}%)`)}`
    );
  }

  console.log(renderCard(`${icons.task} Tasks (${String(tasks.length)})`, taskLines));

  // Next steps hint
  if (sprint.status === 'draft' && tasks.length === 0) {
    log.newline();
    showNextStep('ralphctl sprint plan', 'generate tasks from tickets');
  } else if (sprint.status === 'draft' && tasks.length > 0) {
    log.newline();
    showNextStep('ralphctl sprint start', 'begin implementation');
  }

  log.newline();
}
