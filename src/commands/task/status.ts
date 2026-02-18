import { TaskNotFoundError, updateTaskStatus } from '@src/store/task.ts';
import { formatTaskStatus, log, showError, showNextStep, showSuccess } from '@src/theme/ui.ts';
import { type TaskStatus, TaskStatusSchema } from '@src/schemas/index.ts';
import { SprintStatusError } from '@src/store/sprint.ts';
import { selectTask, selectTaskStatus } from '@src/interactive/selectors.ts';
import { EXIT_ERROR, exitWithCode } from '@src/utils/exit-codes.ts';

const VALID_STATUSES: TaskStatus[] = ['todo', 'in_progress', 'done'];

export interface TaskStatusOptions {
  taskId?: string;
  status?: string;
  noInteractive?: boolean;
}

export async function taskStatusCommand(args: string[], options: TaskStatusOptions = {}): Promise<void> {
  let taskId = args[0] ?? options.taskId;
  let newStatus = args[1] ?? options.status;

  // Non-interactive mode: validate required params, fail fast
  if (options.noInteractive) {
    const errors: string[] = [];

    if (!taskId?.trim()) {
      errors.push('Task ID is required');
    }

    if (!newStatus?.trim()) {
      errors.push('Status is required');
    } else {
      const result = TaskStatusSchema.safeParse(newStatus);
      if (!result.success) {
        errors.push(`Invalid status: ${newStatus} (valid: ${VALID_STATUSES.join(', ')})`);
      }
    }

    if (errors.length > 0) {
      showError('Validation failed');
      for (const e of errors) {
        log.error(e);
      }
      log.newline();
      exitWithCode(EXIT_ERROR);
    }
  }

  // Interactive: select task if not provided
  if (!taskId) {
    const selected = await selectTask('Select task to update:');
    if (!selected) return;
    taskId = selected;
  }

  // Interactive: select status if not provided
  if (!newStatus) {
    const selected = await selectTaskStatus('Select new status:');
    if (!selected) return;
    newStatus = selected;
  }

  const result = TaskStatusSchema.safeParse(newStatus);
  if (!result.success) {
    showError(`Invalid status: ${newStatus}`);
    log.dim(`Valid statuses: ${VALID_STATUSES.join(', ')}`);
    log.newline();

    if (options.noInteractive) {
      exitWithCode(EXIT_ERROR);
    }
    return;
  }

  try {
    const task = await updateTaskStatus(taskId, result.data);
    showSuccess('Task status updated!', [
      ['ID', task.id],
      ['Name', task.name],
      ['Status', formatTaskStatus(task.status)],
    ]);
    log.newline();
  } catch (err) {
    if (err instanceof TaskNotFoundError) {
      showError(`Task not found: ${taskId}`);
      showNextStep('ralphctl task list', 'see available tasks');
      log.newline();
      if (options.noInteractive) {
        exitWithCode(EXIT_ERROR);
      }
    } else if (err instanceof SprintStatusError) {
      showError(err.message);
      log.newline();
      if (options.noInteractive) {
        exitWithCode(EXIT_ERROR);
      }
    } else {
      throw err;
    }
  }
}
