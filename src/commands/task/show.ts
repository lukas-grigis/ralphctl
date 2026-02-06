import { colors, muted } from '@src/theme/index.ts';
import { getTask, TaskNotFoundError } from '@src/store/task.ts';
import {
  boxChars,
  DETAIL_LABEL_WIDTH,
  formatTaskStatus,
  icons,
  log,
  renderCard,
  showError,
  showNextStep,
} from '@src/theme/ui.ts';
import { selectTask } from '@src/interactive/selectors.ts';

const LABEL_W = DETAIL_LABEL_WIDTH;

function labelValue(label: string, value: string): string {
  const paddedLabel = (label + ':').padEnd(LABEL_W);
  return `${colors.muted(paddedLabel)} ${value}`;
}

export async function taskShowCommand(args: string[]): Promise<void> {
  let taskId = args[0];

  if (!taskId) {
    const selected = await selectTask('Select task to show:');
    if (!selected) return;
    taskId = selected;
  }

  try {
    const task = await getTask(taskId);

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
        infoLines.push(`${' '.repeat(LABEL_W + 1)}${line}`);
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

    // Verification card (if verified)
    if (task.verified) {
      log.newline();
      const verifyLines: string[] = [`${colors.success(icons.success)} Verified`];
      if (task.verificationOutput) {
        verifyLines.push(colors.muted(boxChars.light.horizontal.repeat(30)));
        for (const line of task.verificationOutput.split('\n').slice(0, 10)) {
          verifyLines.push(muted(line));
        }
      }
      console.log(renderCard(`${icons.success} Verification`, verifyLines));
    }

    log.newline();
  } catch (err) {
    if (err instanceof TaskNotFoundError) {
      showError(`Task not found: ${taskId}`);
      showNextStep('ralphctl task list', 'see available tasks');
      log.newline();
    } else {
      throw err;
    }
  }
}
