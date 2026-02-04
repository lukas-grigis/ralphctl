import { error, muted, warning } from '@src/theme/index.ts';
import { type RunnerOptions, runSprint } from '@src/claude/runner.ts';
import { SprintNotFoundError, SprintStatusError } from '@src/store/sprint.ts';
import { EXIT_ERROR, EXIT_NO_TASKS, exitWithCode } from '@src/utils/exit-codes.ts';

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
      if (isNaN(count) || count < 1) {
        throw new Error('--count must be a positive integer');
      }
      options.count = count;
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
      console.log(error(`\n${err.message}\n`));
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
      console.log(error(`\nSprint not found: ${sprintId ?? 'unknown'}\n`));
      exitWithCode(EXIT_ERROR);
    } else if (err instanceof SprintStatusError) {
      console.log(error(`\n${err.message}\n`));
      exitWithCode(EXIT_ERROR);
    } else if (err instanceof Error && err.message.includes('No sprint specified')) {
      console.log(warning('\nNo sprint specified and no active sprint set.'));
      console.log(muted('Specify a sprint ID or activate one first.\n'));
      exitWithCode(EXIT_NO_TASKS);
    } else {
      throw err;
    }
  }
}
