/**
 * `ticket assign-repos` — overwrite the affected-repositories list for a
 * ticket. Idempotent: re-running with a different list wins.
 *
 * Pass each absolute path with `--path` (repeat the flag) or pass `--clear`
 * to remove the assignment. Repository paths are not validated against
 * registered projects — the same loose contract `sprint plan` writes.
 */
import type { Command } from 'commander';
import * as c from 'colorette';

import { AssignTicketRepositoriesUseCase } from '../../../business/usecases/ticket/assign-ticket-repositories.ts';
import { Result } from '../../../domain/result.ts';
import { AbsolutePath } from '../../../domain/values/absolute-path.ts';
import { SprintId } from '../../../domain/values/sprint-id.ts';
import { TicketId } from '../../../domain/values/ticket-id.ts';
import type { SharedDeps } from '../../bootstrap/shared-deps.ts';
import { runCommand } from '../command-runner.ts';
import { EXIT_SUCCESS, type ExitCode } from '../exit-codes.ts';

interface TicketAssignReposFlags {
  readonly sprint: string;
  readonly ticket: string;
  readonly path?: string[];
  readonly clear?: boolean;
}

export function attachTicketAssignRepos(group: Command, deps: SharedDeps): void {
  group
    .command('assign-repos')
    .description('overwrite the affected-repositories list on a ticket')
    .requiredOption('--sprint <id>', 'sprint id')
    .requiredOption('--ticket <id>', 'ticket id')
    .option('--path <abs-path...>', 'absolute path to a repo (repeat the flag)')
    .option('--clear', 'clear the assignment (sets to [])')
    .action(async (opts: TicketAssignReposFlags) => {
      const code = await runTicketAssignRepos(deps, opts);
      if (code !== EXIT_SUCCESS) process.exitCode = code;
    });
}

export async function runTicketAssignRepos(deps: SharedDeps, opts: TicketAssignReposFlags): Promise<ExitCode> {
  return runCommand({
    deps,
    body: async () => {
      const sprintId = SprintId.parse(opts.sprint);
      if (!sprintId.ok) return Result.error(sprintId.error);
      const ticketId = TicketId.parse(opts.ticket);
      if (!ticketId.ok) return Result.error(ticketId.error);

      const paths: AbsolutePath[] = [];
      if (opts.clear !== true && opts.path !== undefined) {
        for (const raw of opts.path) {
          const parsed = AbsolutePath.parse(raw);
          if (!parsed.ok) return Result.error(parsed.error);
          paths.push(parsed.value);
        }
      }

      const useCase = new AssignTicketRepositoriesUseCase(deps.sprintRepo);
      return useCase.execute({
        sprintId: sprintId.value,
        ticketId: ticketId.value,
        paths,
      });
    },
    format: () => `${c.green('assigned')} repositories to ticket ${c.bold(opts.ticket)}`,
  });
}
