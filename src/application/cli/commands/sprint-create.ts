/**
 * `sprint create` — start a new draft sprint.
 *
 * Required flags:
 *   --name <text>
 *   --slug <slug>
 */
import type { Command } from 'commander';

import { CreateSprintUseCase } from '../../../business/usecases/sprint/create-sprint.ts';
import { Result } from '../../../domain/result.ts';
import { IsoTimestamp } from '../../../domain/values/iso-timestamp.ts';
import { Slug } from '../../../domain/values/slug.ts';
import type { SharedDeps } from '../../bootstrap/shared-deps.ts';
import { runCommand } from '../command-runner.ts';
import { EXIT_SUCCESS, type ExitCode } from '../exit-codes.ts';
import { formatSprintCard } from '../format/format-sprint.ts';

interface SprintCreateFlags {
  readonly name: string;
  readonly slug: string;
}

export function attachSprintCreate(group: Command, deps: SharedDeps): void {
  group
    .command('create')
    .description('create a new draft sprint')
    .requiredOption('--name <text>', 'human-readable sprint name')
    .requiredOption('--slug <slug>', 'short slug (lowercase alnum + hyphens)')
    .action(async (opts: SprintCreateFlags) => {
      const code = await runSprintCreate(deps, opts);
      if (code !== EXIT_SUCCESS) process.exitCode = code;
    });
}

export async function runSprintCreate(deps: SharedDeps, opts: SprintCreateFlags): Promise<ExitCode> {
  return runCommand({
    deps,
    body: async () => {
      const slug = Slug.parse(opts.slug);
      if (!slug.ok) return Result.error(slug.error);
      const useCase = new CreateSprintUseCase(deps.sprintRepo);
      return useCase.execute({
        name: opts.name,
        slug: slug.value,
        now: IsoTimestamp.now(),
      });
    },
    format: (_d, sprint) => formatSprintCard(sprint),
  });
}
