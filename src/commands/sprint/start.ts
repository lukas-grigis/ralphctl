import { type RunnerOptions, runSprint } from '@src/ai/runner.ts';
import { SprintNotFoundError, SprintStatusError } from '@src/store/sprint.ts';
import { EXIT_ERROR, EXIT_NO_TASKS, exitWithCode } from '@src/utils/exit-codes.ts';
import { log, showError, showNextStep, showWarning } from '@src/theme/ui.ts';

function parseArgs(args: string[]): { sprintId?: string; options: RunnerOptions } {
  const options: RunnerOptions = {
    step: false,
    count: null,
    session: false,
    noCommit: false,
  };
  let sprintId: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '-t' || arg === '--step') {
      options.step = true;
    } else if (arg === '-s' || arg === '--session') {
      options.session = true;
    } else if (arg === '--no-commit') {
      options.noCommit = true;
    } else if (arg === '-c' || arg === '--count') {
      const countStr = args[++i];
      if (!countStr) {
        throw new Error('--count requires a number');
      }
      const count = parseInt(countStr, 10);
      if (isNaN(count) || count < 1 || count > 10000) {
        throw new Error('--count must be an integer between 1 and 10000');
      }
      options.count = count;
    } else if (arg === '--concurrency') {
      const concStr = args[++i];
      if (!concStr) {
        throw new Error('--concurrency requires a number');
      }
      const conc = parseInt(concStr, 10);
      if (isNaN(conc) || conc < 1 || conc > 10) {
        throw new Error('--concurrency must be an integer between 1 and 10');
      }
      options.concurrency = conc;
    } else if (arg === '--max-retries') {
      const retryStr = args[++i];
      if (!retryStr) {
        throw new Error('--max-retries requires a number');
      }
      const retries = parseInt(retryStr, 10);
      if (isNaN(retries) || retries < 0 || retries > 20) {
        throw new Error('--max-retries must be an integer between 0 and 20');
      }
      options.maxRetries = retries;
    } else if (arg === '--fail-fast') {
      options.failFast = true;
    } else if (arg === '--no-fail-fast') {
      options.failFast = false;
    } else if (arg === '-f' || arg === '--force') {
      options.force = true;
    } else if (arg === '--refresh-check') {
      options.refreshCheck = true;
    } else if (arg === '-b' || arg === '--branch') {
      options.branch = true;
    } else if (arg === '--branch-name') {
      const nameStr = args[++i];
      if (!nameStr) {
        throw new Error('--branch-name requires a value');
      }
      options.branchName = nameStr;
    } else if (!arg?.startsWith('-')) {
      sprintId = arg;
    }
  }

  return { sprintId, options };
}

export async function sprintStartCommand(args: string[]): Promise<void> {
  let sprintId: string | undefined;
  let options: RunnerOptions;

  try {
    const parsed = parseArgs(args);
    sprintId = parsed.sprintId;
    options = parsed.options;
  } catch (err) {
    if (err instanceof Error) {
      showError(err.message);
      log.newline();
    }
    exitWithCode(EXIT_ERROR);
  }

  try {
    const summary = await runSprint(sprintId, options);

    // Exit with appropriate code based on execution summary
    if (summary) {
      exitWithCode(summary.exitCode);
    }
  } catch (err) {
    if (err instanceof SprintNotFoundError) {
      showError(`Sprint not found: ${sprintId ?? 'unknown'}`);
      log.newline();
      exitWithCode(EXIT_ERROR);
    } else if (err instanceof SprintStatusError) {
      showError(err.message);
      log.newline();
      exitWithCode(EXIT_ERROR);
    } else if (err instanceof Error && err.message.includes('No sprint specified')) {
      showWarning('No sprint specified and no active sprint set.');
      showNextStep('ralphctl sprint start <id>', 'specify a sprint ID');
      log.newline();
      exitWithCode(EXIT_NO_TASKS);
    } else {
      throw err;
    }
  }
}
