/**
 * `sprint plan` — generate tasks for a draft sprint.
 *
 * Builds the plan chain via {@link createPlanFlow} and streams it through
 * {@link SessionManagerPort}.
 *
 * The AI session's working directory is NOT supplied by the caller — the
 * chain's `build-plan-workspace` leaf materialises a sandbox under
 * `<sprintDir>/workspaces/plan/` and stamps it onto the chain context.
 * Affected repos are exposed to the AI via `--add-dir` (Claude) or via
 * the read-only mirror inside the sandbox (Copilot).
 */
import type { Command } from 'commander';

import { createPlanFlow, type PlanCtx } from '@src/application/chains/plan/plan-flow.ts';
import { SprintId } from '@src/domain/values/sprint-id.ts';
import type { SharedDeps } from '@src/application/bootstrap/shared-deps.ts';
import { printError } from '@src/application/cli/command-runner.ts';
import { EXIT_ERROR, EXIT_SUCCESS, type ExitCode } from '@src/application/cli/exit-codes.ts';
import { streamSession } from '@src/application/cli/stream-session.ts';

interface SprintPlanFlags {
  readonly sprint: string;
  /** When true, force headless mode regardless of TTY — for CI / non-interactive contexts. */
  readonly auto?: boolean;
}

export function attachSprintPlan(group: Command, deps: SharedDeps): void {
  group
    .command('plan')
    .description('generate tasks from approved tickets')
    .requiredOption('--sprint <id>', 'sprint id')
    .option('--auto', 'run headless — Claude decides what a human would have answered (CI / batch mode)')
    .action(async (opts: SprintPlanFlags) => {
      const code = await runSprintPlan(deps, opts);
      if (code !== EXIT_SUCCESS) process.exitCode = code;
    });
}

async function runSprintPlan(deps: SharedDeps, opts: SprintPlanFlags): Promise<ExitCode> {
  const sprintId = SprintId.parse(opts.sprint);
  if (!sprintId.ok) {
    printError(deps, sprintId.error);
    return EXIT_ERROR;
  }

  // Default: interactive on a TTY, headless otherwise. `--auto` forces
  // headless even on a TTY.
  const ttyInteractive = process.stdout.isTTY && process.env['RALPHCTL_NO_TUI'] !== '1';
  const interactive = opts.auto === true ? false : ttyInteractive;
  const sprintDir = String(deps.storage.sprintDir(sprintId.value));
  const outputFilePath = interactive ? `${sprintDir}/planning/tasks.json` : undefined;

  const flow = createPlanFlow(deps, {
    sprintId: sprintId.value,
    interactive,
    ...(outputFilePath !== undefined ? { outputFilePath } : {}),
  });

  return streamSession<PlanCtx>({
    sessionManager: deps.sessionManager,
    label: `plan ${sprintId.value}`,
    element: flow,
    initialCtx: { sprintId: sprintId.value },
  });
}
