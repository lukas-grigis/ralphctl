/**
 * `sprint list` — enumerate every persisted sprint.
 */
import type { Command } from 'commander';
import * as c from 'colorette';

import { ListSprintsUseCase } from '@src/business/usecases/sprint/list-sprints.ts';
import type { SharedDeps } from '@src/application/bootstrap/shared-deps.ts';
import { runCommand } from '@src/application/cli/command-runner.ts';
import { EXIT_SUCCESS, type ExitCode } from '@src/application/cli/exit-codes.ts';
import { formatSprintLine } from '@src/application/cli/format/format-sprint.ts';

export function attachSprintList(group: Command, deps: SharedDeps): void {
  group
    .command('list')
    .description('list every persisted sprint')
    .action(async () => {
      const code = await runSprintList(deps);
      if (code !== EXIT_SUCCESS) process.exitCode = code;
    });
}

export async function runSprintList(deps: SharedDeps): Promise<ExitCode> {
  return runCommand({
    deps,
    body: () => new ListSprintsUseCase(deps.sprintRepo).execute(),
    format: (_d, sprints) => {
      if (sprints.length === 0) return c.dim('No sprints yet — run `ralphctl sprint create`.');
      return [c.bold('Sprints'), ...sprints.map(formatSprintLine)].join('\n');
    },
  });
}
