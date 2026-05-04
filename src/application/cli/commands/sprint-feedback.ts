/**
 * `sprint feedback` — run one round of the post-execute feedback loop.
 *
 * The feedback chain is per-iteration. The CLI surfaces this as a single
 * round; multi-round usage is the operator looping the command. Empty
 * feedback exits without spawning the chain.
 */
import type { Command } from 'commander';
import * as c from 'colorette';

import { createFeedbackFlow, type FeedbackCtx } from '@src/application/chains/feedback/feedback-flow.ts';
import { AbsolutePath } from '@src/domain/values/absolute-path.ts';
import { SprintId } from '@src/domain/values/sprint-id.ts';
import type { SharedDeps } from '@src/application/bootstrap/shared-deps.ts';
import { printError } from '@src/application/cli/command-runner.ts';
import { EXIT_ERROR, EXIT_SUCCESS, type ExitCode } from '@src/application/cli/exit-codes.ts';
import { streamSession } from '@src/application/cli/stream-session.ts';

interface SprintFeedbackFlags {
  readonly sprint: string;
  readonly text: string;
  readonly iteration?: string;
  readonly cwd?: string;
}

export function attachSprintFeedback(group: Command, deps: SharedDeps): void {
  group
    .command('feedback')
    .description('apply one round of post-execute feedback')
    .requiredOption('--sprint <id>', 'sprint id')
    .requiredOption('--text <text>', 'feedback text')
    .option('--iteration <n>', '1-indexed iteration counter', '1')
    .option('--cwd <abs>', 'working directory for the AI session', process.cwd())
    .action(async (opts: SprintFeedbackFlags) => {
      const code = await runSprintFeedback(deps, opts);
      if (code !== EXIT_SUCCESS) process.exitCode = code;
    });
}

async function runSprintFeedback(deps: SharedDeps, opts: SprintFeedbackFlags): Promise<ExitCode> {
  const trimmed = opts.text.trim();
  if (trimmed.length === 0) {
    process.stdout.write(c.dim('No feedback provided — exiting.') + '\n');
    return EXIT_SUCCESS;
  }
  const sprintId = SprintId.parse(opts.sprint);
  if (!sprintId.ok) {
    printError(deps, sprintId.error);
    return EXIT_ERROR;
  }
  const cwd = AbsolutePath.parse(opts.cwd ?? process.cwd());
  if (!cwd.ok) {
    printError(deps, cwd.error);
    return EXIT_ERROR;
  }
  const iteration = Math.max(1, Number.parseInt(opts.iteration ?? '1', 10) || 1);

  const flow = createFeedbackFlow(deps);

  return streamSession<FeedbackCtx>({
    sessionManager: deps.sessionManager,
    label: `feedback ${sprintId.value}#${String(iteration)}`,
    element: flow,
    initialCtx: {
      sprintId: sprintId.value,
      cwd: cwd.value,
      feedbackText: trimmed,
      iteration,
    },
  });
}
