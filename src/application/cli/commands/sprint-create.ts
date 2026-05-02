/**
 * `sprint create` — start a new draft sprint.
 *
 * Required flags:
 *   --name <text>
 *   --slug <slug>
 *   --project <name>
 */
import type { Command } from 'commander';

import { CreateSprintUseCase } from '@src/business/usecases/sprint/create-sprint.ts';
import { IsoTimestamp } from '@src/domain/values/iso-timestamp.ts';
import { ProjectName } from '@src/domain/values/project-name.ts';
import { Slug } from '@src/domain/values/slug.ts';
import type { SharedDeps } from '@src/application/bootstrap/shared-deps.ts';
import { parseId, runCommand } from '@src/application/cli/command-runner.ts';
import { EXIT_SUCCESS, type ExitCode } from '@src/application/cli/exit-codes.ts';
import { formatSprintCard } from '@src/application/cli/format/format-sprint.ts';

interface SprintCreateFlags {
  readonly name: string;
  readonly slug: string;
  readonly project: string;
}

export function attachSprintCreate(group: Command, deps: SharedDeps): void {
  group
    .command('create')
    .description('create a new draft sprint')
    .requiredOption('--name <text>', 'human-readable sprint name')
    .requiredOption('--slug <slug>', 'short slug (lowercase alnum + hyphens)')
    .requiredOption('--project <name>', 'project this sprint targets')
    .action(async (opts: SprintCreateFlags) => {
      const code = await runSprintCreate(deps, opts);
      if (code !== EXIT_SUCCESS) process.exitCode = code;
    });
}

export async function runSprintCreate(deps: SharedDeps, opts: SprintCreateFlags): Promise<ExitCode> {
  return runCommand({
    deps,
    body: async () => {
      const slug = parseId(Slug, opts.slug);
      if (!slug.ok) return slug;
      const projectName = parseId(ProjectName, opts.project);
      if (!projectName.ok) return projectName;
      const useCase = new CreateSprintUseCase(deps.sprintRepo);
      return useCase.execute({
        name: opts.name,
        slug: slug.value,
        now: IsoTimestamp.now(),
        projectName: projectName.value,
      });
    },
    format: (_d, sprint) => formatSprintCard(sprint),
  });
}
