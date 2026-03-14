import { ensureError, wrapAsync } from '@src/utils/result-helpers.ts';
import { colors, muted } from '@src/theme/index.ts';
import { getTask, TaskNotFoundError } from '@src/store/task.ts';
import { getTicket } from '@src/store/ticket.ts';
import {
  DETAIL_LABEL_WIDTH,
  formatTaskStatus,
  horizontalLine,
  icons,
  labelValue,
  log,
  renderCard,
  showError,
  showNextStep,
} from '@src/theme/ui.ts';
import { selectTask } from '@src/interactive/selectors.ts';

export async function taskShowCommand(args: string[]): Promise<void> {
  let taskId = args[0];

  if (!taskId) {
    const selected = await selectTask('Select task to show:');
    if (!selected) return;
    taskId = selected;
  }

  const taskR = await wrapAsync(() => getTask(taskId), ensureError);
  if (!taskR.ok) {
    if (taskR.error instanceof TaskNotFoundError) {
      showError(`Task not found: ${taskId}`);
      showNextStep('ralphctl task list', 'see available tasks');
      log.newline();
    } else {
      throw taskR.error;
    }
    return;
  }
  const task = taskR.value;

  // Task info card
  const infoLines: string[] = [
    labelValue('ID', task.id),
    labelValue('Status', formatTaskStatus(task.status)),
    labelValue('Order', String(task.order)),
    labelValue('Project', task.projectPath),
  ];

  if (task.ticketId) {
    infoLines.push(labelValue('Ticket', task.ticketId));
  }

  if (task.description) {
    infoLines.push('');
    infoLines.push(labelValue('Description', ''));
    for (const line of task.description.split('\n')) {
      infoLines.push(`${' '.repeat(DETAIL_LABEL_WIDTH + 1)}${line}`);
    }
  }

  log.newline();
  console.log(renderCard(`${icons.task} ${task.name}`, infoLines));

  // Steps card (if any)
  if (task.steps.length > 0) {
    log.newline();
    const stepLines: string[] = [];
    for (let i = 0; i < task.steps.length; i++) {
      const step = task.steps[i] ?? '';
      const checkbox = task.status === 'done' ? colors.success('[x]') : muted('[ ]');
      stepLines.push(`${checkbox} ${muted(String(i + 1) + '.')} ${step}`);
    }
    console.log(renderCard(`${icons.bullet} Steps (${String(task.steps.length)})`, stepLines));
  }

  // Dependencies card (if any)
  if (task.blockedBy.length > 0) {
    log.newline();
    const depLines: string[] = [];
    for (const dep of task.blockedBy) {
      depLines.push(`${icons.bullet} ${dep}`);
    }
    console.log(renderCard(`${icons.warning} Blocked By`, depLines));
  }

  // Requirements card (from linked ticket, if refined)
  if (task.ticketId) {
    const taskTicketId = task.ticketId;
    const ticketR = await wrapAsync(() => getTicket(taskTicketId), ensureError);
    if (ticketR.ok && ticketR.value.requirements) {
      log.newline();
      const reqLines = ticketR.value.requirements.split('\n');
      console.log(renderCard(`${icons.ticket} Requirements`, reqLines));
    }
    // Ticket may not exist anymore - silently skip
  }

  // Verification card (if verified)
  if (task.verified) {
    log.newline();
    const verifyLines: string[] = [`${colors.success(icons.success)} Verified`];
    if (task.verificationOutput) {
      verifyLines.push(colors.muted(horizontalLine(30, 'rounded')));
      for (const line of task.verificationOutput.split('\n').slice(0, 10)) {
        verifyLines.push(muted(line));
      }
    }
    console.log(renderCard(`${icons.success} Verification`, verifyLines));
  }

  log.newline();
}
