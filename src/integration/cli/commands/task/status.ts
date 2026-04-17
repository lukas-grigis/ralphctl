import { ensureError, wrapAsync } from '@src/integration/utils/result-helpers.ts';
import { TaskNotFoundError, updateTaskStatus } from '@src/integration/persistence/task.ts';
import { formatTaskStatus, log, showError, showNextStep, showSuccess } from '@src/integration/ui/theme/ui.ts';
import { type TaskStatus, TaskStatusSchema } from '@src/domain/models.ts';
import { SprintStatusError } from '@src/integration/persistence/sprint.ts';
import { selectTask, selectTaskStatus } from '@src/integration/cli/commands/shared/selectors.ts';
import { EXIT_ERROR, exitWithCode } from '@src/integration/utils/exit-codes.ts';

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

  const updateR = await wrapAsync(() => updateTaskStatus(taskId, result.data), ensureError);
  if (!updateR.ok) {
    if (updateR.error instanceof TaskNotFoundError) {
      showError(`Task not found: ${taskId}`);
      showNextStep('ralphctl task list', 'see available tasks');
      log.newline();
      if (options.noInteractive) {
        exitWithCode(EXIT_ERROR);
      }
    } else if (updateR.error instanceof SprintStatusError) {
      showError(updateR.error.message);
      log.newline();
      if (options.noInteractive) {
        exitWithCode(EXIT_ERROR);
      }
    } else {
      throw updateR.error;
    }
    return;
  }

  showSuccess('Task status updated!', [
    ['ID', updateR.value.id],
    ['Name', updateR.value.name],
    ['Status', formatTaskStatus(updateR.value.status)],
  ]);
  log.newline();
}
