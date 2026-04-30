/**
 * `sprint plan` — generate tasks for a draft sprint.
 *
 * Builds the plan chain via {@link createPlanFlow} and streams it through
 * {@link SessionManagerPort}.
 */
import type { Command } from 'commander';

import { createPlanFlow, type PlanCtx } from '../../chains/plan/plan-flow.ts';
import { AbsolutePath } from '../../../domain/values/absolute-path.ts';
import { SprintId } from '../../../domain/values/sprint-id.ts';
import type { SharedDeps } from '../../bootstrap/shared-deps.ts';
import { printError } from '../command-runner.ts';
import { EXIT_ERROR, EXIT_SUCCESS, type ExitCode } from '../exit-codes.ts';
import { streamSession } from '../stream-session.ts';

interface SprintPlanFlags {
  readonly sprint: string;
  readonly cwd?: string;
}

export function attachSprintPlan(group: Command, deps: SharedDeps): void {
  group
    .command('plan')
    .description('generate tasks from approved tickets')
    .requiredOption('--sprint <id>', 'sprint id')
    .option('--cwd <abs>', 'working directory for the AI session', process.cwd())
    .action(async (opts: SprintPlanFlags) => {
      const code = await runSprintPlan(deps, opts);
      if (code !== EXIT_SUCCESS) process.exitCode = code;
    });
}

export async function runSprintPlan(deps: SharedDeps, opts: SprintPlanFlags): Promise<ExitCode> {
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

  const flow = createPlanFlow(deps, {
    sprintId: sprintId.value,
    cwd: cwd.value,
  });

  return streamSession<PlanCtx>({
    sessionManager: deps.sessionManager,
    label: `plan ${sprintId.value}`,
    element: flow,
    initialCtx: { sprintId: sprintId.value, cwd: cwd.value },
  });
}
