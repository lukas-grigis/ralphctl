/**
 * `sprint close <id>` — close an active sprint.
 */
import type { Command } from 'commander';

import { CloseSprintUseCase } from '@src/business/usecases/sprint/close-sprint.ts';
import { IsoTimestamp } from '@src/domain/values/iso-timestamp.ts';
import { SprintId } from '@src/domain/values/sprint-id.ts';
import type { SharedDeps } from '@src/application/bootstrap/shared-deps.ts';
import { parseId, runCommand } from '@src/application/cli/command-runner.ts';
import { EXIT_SUCCESS, type ExitCode } from '@src/application/cli/exit-codes.ts';
import { formatSprintCard } from '@src/application/cli/format/format-sprint.ts';

export function attachSprintClose(group: Command, deps: SharedDeps): void {
  group
    .command('close <id>')
    .description('close an active sprint')
    .action(async (id: string) => {
      const code = await runSprintClose(deps, id);
      if (code !== EXIT_SUCCESS) process.exitCode = code;
    });
}

export async function runSprintClose(deps: SharedDeps, id: string): Promise<ExitCode> {
  return runCommand({
    deps,
    body: async () => {
      const parsed = parseId(SprintId, id);
      if (!parsed.ok) return parsed;
      return new CloseSprintUseCase(deps.sprintRepo).execute({
        id: parsed.value,
        now: IsoTimestamp.now(),
      });
    },
    format: (_d, sprint) => formatSprintCard(sprint),
  });
}
