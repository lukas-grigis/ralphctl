import { confirm } from '@inquirer/prompts';
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

  try {
    const task = await getTask(taskId);

    if (!skipConfirm) {
      const confirmed = await confirm({
        message: `Remove task "${task.name}" (${task.id})?`,
        default: false,
      });

      if (!confirmed) {
        console.log(muted('\nTask removal cancelled.\n'));
        return;
      }
    }

    await removeTask(taskId);
    showSuccess('Task removed', [['ID', taskId]]);
    log.newline();
  } catch (err) {
    if (err instanceof TaskNotFoundError) {
      showError(`Task not found: ${taskId}`);
      log.newline();
    } else if (err instanceof SprintStatusError) {
      showError(err.message);
      log.newline();
    } else {
      throw err;
    }
  }
}
