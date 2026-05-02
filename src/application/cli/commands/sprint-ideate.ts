/**
 * `sprint ideate` — quick path that combines refine + plan for a free-form idea.
 */
import type { Command } from 'commander';

import { createIdeateFlow, type IdeateCtx } from '@src/application/chains/ideate/ideate-flow.ts';
import { AbsolutePath } from '@src/domain/values/absolute-path.ts';
import { ProjectName } from '@src/domain/values/project-name.ts';
import { SprintId } from '@src/domain/values/sprint-id.ts';
import type { SharedDeps } from '@src/application/bootstrap/shared-deps.ts';
import { printError } from '@src/application/cli/command-runner.ts';
import { EXIT_ERROR, EXIT_SUCCESS, type ExitCode } from '@src/application/cli/exit-codes.ts';
import { streamSession } from '@src/application/cli/stream-session.ts';

interface SprintIdeateFlags {
  readonly sprint: string;
  readonly project: string;
  readonly idea: string;
  readonly cwd?: string;
}

export function attachSprintIdeate(group: Command, deps: SharedDeps): void {
  group
    .command('ideate')
    .description('quick path: free-form idea → ticket + tasks via AI')
    .requiredOption('--sprint <id>', 'draft sprint id')
    .requiredOption('--project <name>', 'project the idea targets')
    .requiredOption('--idea <text>', 'free-form idea text')
    .option('--cwd <abs>', 'working directory for the AI session', process.cwd())
    .action(async (opts: SprintIdeateFlags) => {
      const code = await runSprintIdeate(deps, opts);
      if (code !== EXIT_SUCCESS) process.exitCode = code;
    });
}

async function runSprintIdeate(deps: SharedDeps, opts: SprintIdeateFlags): Promise<ExitCode> {
  const sprintId = SprintId.parse(opts.sprint);
  if (!sprintId.ok) {
    printError(deps, sprintId.error);
    return EXIT_ERROR;
  }
  const projectName = ProjectName.parse(opts.project);
  if (!projectName.ok) {
    printError(deps, projectName.error);
    return EXIT_ERROR;
  }
  const cwd = AbsolutePath.parse(opts.cwd ?? process.cwd());
  if (!cwd.ok) {
    printError(deps, cwd.error);
    return EXIT_ERROR;
  }

  const flow = createIdeateFlow(deps, {
    sprintId: sprintId.value,
    cwd: cwd.value,
    projectName: projectName.value,
    ideaText: opts.idea,
  });

  return streamSession<IdeateCtx>({
    sessionManager: deps.sessionManager,
    label: `ideate ${sprintId.value}`,
    element: flow,
    initialCtx: {
      sprintId: sprintId.value,
      cwd: cwd.value,
      projectName: projectName.value,
      ideaText: opts.idea,
    },
  });
}
