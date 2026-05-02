/**
 * `sprint show <id>` — render one sprint's full card.
 */
import type { Command } from 'commander';

import { ShowSprintUseCase } from '@src/business/usecases/sprint/show-sprint.ts';
import { SprintId } from '@src/domain/values/sprint-id.ts';
import type { SharedDeps } from '@src/application/bootstrap/shared-deps.ts';
import { parseId, runCommand } from '@src/application/cli/command-runner.ts';
import { EXIT_SUCCESS, type ExitCode } from '@src/application/cli/exit-codes.ts';
import { formatSprintCard, formatTicketsTable } from '@src/application/cli/format/format-sprint.ts';

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
      const parsed = parseId(SprintId, id);
      if (!parsed.ok) return parsed;
      return new ShowSprintUseCase(deps.sprintRepo).execute({ id: parsed.value });
    },
    format: (_d, sprint) => `${formatSprintCard(sprint)}\n${formatTicketsTable(sprint)}`,
  });
}
