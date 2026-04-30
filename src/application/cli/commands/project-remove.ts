/**
 * `project remove <name>` — drop a project from the registry.
 */
import type { Command } from 'commander';
import * as c from 'colorette';

import { Result } from '../../../domain/result.ts';
import { ProjectName } from '../../../domain/values/project-name.ts';
import { RemoveProjectUseCase } from '../../../business/usecases/project/remove-project.ts';
import type { SharedDeps } from '../../bootstrap/shared-deps.ts';
import { runCommand } from '../command-runner.ts';
import { EXIT_SUCCESS, type ExitCode } from '../exit-codes.ts';

export function attachProjectRemove(group: Command, deps: SharedDeps): void {
  group
    .command('remove <name>')
    .description('remove a project from the registry')
    .action(async (name: string) => {
      const code = await runProjectRemove(deps, name);
      if (code !== EXIT_SUCCESS) process.exitCode = code;
    });
}

export async function runProjectRemove(deps: SharedDeps, name: string): Promise<ExitCode> {
  return runCommand({
    deps,
    body: async () => {
      const parsed = ProjectName.parse(name);
      if (!parsed.ok) return Result.error(parsed.error);
      return new RemoveProjectUseCase(deps.projectRepo).execute({ name: parsed.value });
    },
    format: () => `${c.green('removed')} project ${c.bold(name)}`,
  });
}
