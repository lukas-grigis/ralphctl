/**
 * `project show <name>` — print a single project's details.
 */
import type { Command } from 'commander';

import { ProjectName } from '../../../domain/values/project-name.ts';
import { ShowProjectUseCase } from '../../../business/usecases/project/show-project.ts';
import type { SharedDeps } from '../../bootstrap/shared-deps.ts';
import { parseId, runCommand } from '../command-runner.ts';
import { EXIT_SUCCESS, type ExitCode } from '../exit-codes.ts';
import { formatProjectCard } from '../format/format-project.ts';

export function attachProjectShow(group: Command, deps: SharedDeps): void {
  group
    .command('show <name>')
    .description('show a project by name')
    .action(async (name: string) => {
      const code = await runProjectShow(deps, name);
      if (code !== EXIT_SUCCESS) process.exitCode = code;
    });
}

export async function runProjectShow(deps: SharedDeps, name: string): Promise<ExitCode> {
  return runCommand({
    deps,
    body: async () => {
      const parsed = parseId(ProjectName, name);
      if (!parsed.ok) return parsed;
      return new ShowProjectUseCase(deps.projectRepo).execute({ name: parsed.value });
    },
    format: (_d, p) => formatProjectCard(p),
  });
}
