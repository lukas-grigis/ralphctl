/**
 * `sprint edit` — change a sprint's name and/or branch.
 *
 * Use `--branch ""` to clear a previously-set branch. Closed sprints
 * reject every edit (the entity enforces the lifecycle).
 */
import type { Command } from 'commander';

import { EditSprintUseCase } from '../../../business/usecases/sprint/edit-sprint.ts';
import { Result } from '../../../domain/result.ts';
import { SprintId } from '../../../domain/values/sprint-id.ts';
import type { SharedDeps } from '../../bootstrap/shared-deps.ts';
import { runCommand } from '../command-runner.ts';
import { EXIT_SUCCESS, type ExitCode } from '../exit-codes.ts';
import { formatSprintCard } from '../format/format-sprint.ts';

interface SprintEditFlags {
  readonly id: string;
  readonly name?: string;
  readonly branch?: string;
}

export function attachSprintEdit(group: Command, deps: SharedDeps): void {
  group
    .command('edit')
    .description("rename a sprint or change its branch (use --branch '' to clear)")
    .requiredOption('--id <id>', 'sprint id')
    .option('--name <text>', 'new sprint name')
    .option('--branch <name>', 'new branch name (empty string clears)')
    .action(async (opts: SprintEditFlags) => {
      const code = await runSprintEdit(deps, opts);
      if (code !== EXIT_SUCCESS) process.exitCode = code;
    });
}

export async function runSprintEdit(deps: SharedDeps, opts: SprintEditFlags): Promise<ExitCode> {
  return runCommand({
    deps,
    body: async () => {
      const id = SprintId.parse(opts.id);
      if (!id.ok) return Result.error(id.error);

      const useCase = new EditSprintUseCase(deps.sprintRepo);
      return useCase.execute({
        id: id.value,
        ...(opts.name !== undefined ? { name: opts.name } : {}),
        ...(opts.branch !== undefined ? { branch: opts.branch === '' ? null : opts.branch } : {}),
      });
    },
    format: (_d, sprint) => formatSprintCard(sprint),
  });
}
