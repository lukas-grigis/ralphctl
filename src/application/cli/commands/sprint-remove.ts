/**
 * `sprint remove <id>` — delete a sprint.
 */
import type { Command } from 'commander';
import * as c from 'colorette';

import { RemoveSprintUseCase } from '@src/business/usecases/sprint/remove-sprint.ts';
import { SprintId } from '@src/domain/values/sprint-id.ts';
import type { SharedDeps } from '@src/application/bootstrap/shared-deps.ts';
import { parseId, runCommand } from '@src/application/cli/command-runner.ts';
import { EXIT_SUCCESS, type ExitCode } from '@src/application/cli/exit-codes.ts';

export function attachSprintRemove(group: Command, deps: SharedDeps): void {
  group
    .command('remove <id>')
    .description('delete a sprint')
    .action(async (id: string) => {
      const code = await runSprintRemove(deps, id);
      if (code !== EXIT_SUCCESS) process.exitCode = code;
    });
}

export async function runSprintRemove(deps: SharedDeps, id: string): Promise<ExitCode> {
  return runCommand({
    deps,
    body: async () => {
      const parsed = parseId(SprintId, id);
      if (!parsed.ok) return parsed;
      return new RemoveSprintUseCase(deps.sprintRepo).execute({ id: parsed.value });
    },
    format: () => `${c.green('removed')} sprint ${c.bold(id)}`,
  });
}
