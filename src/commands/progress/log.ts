import { wrapAsync } from '@src/utils/result-helpers.ts';
import { log, showError, showNextStep, showSuccess } from '@src/theme/ui.ts';
import { logProgress } from '@src/store/progress.ts';
import {
  assertSprintStatus,
  getSprint,
  NoCurrentSprintError,
  resolveSprintId,
  SprintStatusError,
} from '@src/store/sprint.ts';
import { editorInput } from '@src/utils/editor-input.ts';

export async function progressLogCommand(args: string[]): Promise<void> {
  // FAIL FAST: Check sprint status before collecting any input
  const statusCheckR = await wrapAsync(
    async () => {
      const sprintId = await resolveSprintId();
      const sprint = await getSprint(sprintId);
      assertSprintStatus(sprint, ['active'], 'log progress');
    },
    (err) => (err instanceof Error ? err : new Error(String(err)))
  );
  if (!statusCheckR.ok) {
    const err = statusCheckR.error;
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
    const editorR = await editorInput({
      message: 'Progress message:',
    });
    if (!editorR.ok) {
      showError(`Editor input failed: ${editorR.error.message}`);
      log.newline();
      return;
    }
    message = editorR.value;
    message = message.trim();
  }

  if (!message) {
    showError('No message provided.');
    log.newline();
    return;
  }

  const logR = await wrapAsync(
    () => logProgress(message),
    (err) => (err instanceof Error ? err : new Error(String(err)))
  );
  if (!logR.ok) {
    if (logR.error instanceof SprintStatusError) {
      // Fallback handler (shouldn't reach here due to early check)
      showError(logR.error.message);
      log.newline();
    } else {
      throw logR.error;
    }
    return;
  }

  showSuccess('Progress logged.');
  log.newline();
}
