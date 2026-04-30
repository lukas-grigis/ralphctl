/**
 * `sprint show <id>` — render one sprint's full card.
 */
import type { Command } from 'commander';

import { ShowSprintUseCase } from '../../../business/usecases/sprint/show-sprint.ts';
import { Result } from '../../../domain/result.ts';
import { SprintId } from '../../../domain/values/sprint-id.ts';
import type { SharedDeps } from '../../bootstrap/shared-deps.ts';
import { runCommand } from '../command-runner.ts';
import { EXIT_SUCCESS, type ExitCode } from '../exit-codes.ts';
import { formatSprintCard, formatTicketsTable } from '../format/format-sprint.ts';

export function attachSprintShow(group: Command, deps: SharedDeps): void {
  group
    .command('show <id>')
    .description('show a sprint and its tickets')
    .action(async (id: string) => {
      const code = await runSprintShow(deps, id);
      if (code !== EXIT_SUCCESS) process.exitCode = code;
    });
}

export async function runSprintShow(deps: SharedDeps, id: string): Promise<ExitCode> {
  return runCommand({
    deps,
    body: async () => {
      const parsed = SprintId.parse(id);
      if (!parsed.ok) return Result.error(parsed.error);
      return new ShowSprintUseCase(deps.sprintRepo).execute({ id: parsed.value });
    },
    format: (_d, sprint) => `${formatSprintCard(sprint)}\n${formatTicketsTable(sprint)}`,
  });
}
