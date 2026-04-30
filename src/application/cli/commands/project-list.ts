/**
 * `project list` — enumerate every registered project.
 */
import type { Command } from 'commander';
import * as c from 'colorette';

import { ListProjectsUseCase } from '../../../business/usecases/project/list-projects.ts';
import type { SharedDeps } from '../../bootstrap/shared-deps.ts';
import { runCommand } from '../command-runner.ts';
import { EXIT_SUCCESS, type ExitCode } from '../exit-codes.ts';
import { formatProjectLine } from '../format/format-project.ts';

export function attachProjectList(group: Command, deps: SharedDeps): void {
  group
    .command('list')
    .description('list registered projects')
    .action(async () => {
      const code = await runProjectList(deps);
      if (code !== EXIT_SUCCESS) process.exitCode = code;
    });
}

export async function runProjectList(deps: SharedDeps): Promise<ExitCode> {
  return runCommand({
    deps,
    body: () => new ListProjectsUseCase(deps.projectRepo).execute(),
    format: (_d, projects) => {
      if (projects.length === 0) return c.dim('No projects yet — run `ralphctl project add`.');
      return [c.bold('Projects'), ...projects.map(formatProjectLine)].join('\n');
    },
  });
}
