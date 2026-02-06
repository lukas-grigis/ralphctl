import { success } from '@src/theme/index.ts';
import { log, showError, showNextStep } from '@src/theme/ui.ts';
import { logProgress } from '@src/store/progress.ts';
import {
  assertSprintStatus,
  getSprint,
  NoCurrentSprintError,
  resolveSprintId,
  SprintStatusError,
} from '@src/store/sprint.ts';
import { multilineInput } from '@src/utils/multiline.ts';

export async function progressLogCommand(args: string[]): Promise<void> {
  // FAIL FAST: Check sprint status before collecting any input
  try {
    const sprintId = await resolveSprintId();
    const sprint = await getSprint(sprintId);
    assertSprintStatus(sprint, ['active'], 'log progress');
  } catch (err) {
    if (err instanceof SprintStatusError) {
      const mainError = err.message.split('\n')[0] ?? err.message;
      showError(mainError);
      showNextStep('ralphctl sprint start', 'activate the sprint');
      log.newline();
      return;
    }
    if (err instanceof NoCurrentSprintError) {
      showError('No current sprint set.');
      showNextStep('ralphctl sprint create', 'create a new sprint');
      log.newline();
      return;
    }
    throw err;
  }

  // Validation passed - now collect input
  let message = args.join(' ').trim();

  if (!message) {
    message = await multilineInput({
      message: 'Progress message:',
    });
    message = message.trim();
  }

  if (!message) {
    showError('No message provided.');
    log.newline();
    return;
  }

  try {
    await logProgress(message);
    console.log(success('\nProgress logged successfully.\n'));
  } catch (err) {
    if (err instanceof SprintStatusError) {
      // Fallback handler (shouldn't reach here due to early check)
      showError(err.message);
      log.newline();
    } else {
      throw err;
    }
  }
}
