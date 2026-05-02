/**
 * `sprint activate` — explicit "draft → active" transition.
 *
 * `sprint start` auto-activates draft sprints, so this command is for
 * users who want to activate without immediately starting execution
 * (e.g. so other commands that require `active` can run).
 */
import type { Command } from 'commander';

import { ActivateSprintUseCase } from '@src/business/usecases/sprint/activate-sprint.ts';
import { IsoTimestamp } from '@src/domain/values/iso-timestamp.ts';
import { SprintId } from '@src/domain/values/sprint-id.ts';
import type { SharedDeps } from '@src/application/bootstrap/shared-deps.ts';
import { parseId, runCommand } from '@src/application/cli/command-runner.ts';
import { EXIT_SUCCESS, type ExitCode } from '@src/application/cli/exit-codes.ts';
import { formatSprintCard } from '@src/application/cli/format/format-sprint.ts';

interface SprintActivateFlags {
  readonly id: string;
}

export function attachSprintActivate(group: Command, deps: SharedDeps): void {
  group
    .command('activate')
    .description('move a draft sprint to active without starting execution')
    .requiredOption('--id <id>', 'sprint id')
    .action(async (opts: SprintActivateFlags) => {
      const code = await runSprintActivate(deps, opts);
      if (code !== EXIT_SUCCESS) process.exitCode = code;
    });
}

async function runSprintActivate(deps: SharedDeps, opts: SprintActivateFlags): Promise<ExitCode> {
  return runCommand({
    deps,
    body: async () => {
      const id = parseId(SprintId, opts.id);
      if (!id.ok) return id;
      const useCase = new ActivateSprintUseCase(deps.sprintRepo);
      return useCase.execute({ id: id.value, now: IsoTimestamp.now() });
    },
    format: (_d, sprint) => formatSprintCard(sprint),
  });
}
