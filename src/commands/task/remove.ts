import { confirm } from '@inquirer/prompts';
import { wrapAsync } from '@src/utils/result-helpers.ts';
import { muted } from '@src/theme/index.ts';
import { getTask, removeTask, TaskNotFoundError } from '@src/store/task.ts';
import { SprintStatusError } from '@src/store/sprint.ts';
import { selectTask } from '@src/interactive/selectors.ts';
import { log, showError, showSuccess } from '@src/theme/ui.ts';

export async function taskRemoveCommand(args: string[]): Promise<void> {
  const skipConfirm = args.includes('-y') || args.includes('--yes');
  let taskId = args.find((a) => !a.startsWith('-'));

  if (!taskId) {
    const selected = await selectTask('Select task to remove:');
    if (!selected) return;
    taskId = selected;
  }

  const opR = await wrapAsync(
    async () => {
      const task = await getTask(taskId);

      if (!skipConfirm) {
        const confirmed = await confirm({
          message: `Remove task "${task.name}" (${task.id})?`,
          default: false,
        });

        if (!confirmed) {
          console.log(muted('\nTask removal cancelled.\n'));
          return null;
        }
      }

      await removeTask(taskId);
      return task;
    },
    (err) => (err instanceof Error ? err : new Error(String(err)))
  );
  if (!opR.ok) {
    if (opR.error instanceof TaskNotFoundError) {
      showError(`Task not found: ${taskId}`);
      log.newline();
    } else if (opR.error instanceof SprintStatusError) {
      showError(opR.error.message);
      log.newline();
    } else {
      throw opR.error;
    }
    return;
  }

  if (opR.value !== null) {
    showSuccess('Task removed', [['ID', taskId]]);
    log.newline();
  }
}
