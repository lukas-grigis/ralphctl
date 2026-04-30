/**
 * `ticket remove` — drop a ticket from a draft sprint.
 */
import type { Command } from 'commander';
import * as c from 'colorette';

import { RemoveTicketUseCase } from '../../../business/usecases/ticket/remove-ticket.ts';
import { Result } from '../../../domain/result.ts';
import { SprintId } from '../../../domain/values/sprint-id.ts';
import { TicketId } from '../../../domain/values/ticket-id.ts';
import type { SharedDeps } from '../../bootstrap/shared-deps.ts';
import { runCommand } from '../command-runner.ts';
import { EXIT_SUCCESS, type ExitCode } from '../exit-codes.ts';

interface TicketRemoveFlags {
  readonly sprint: string;
  readonly ticket: string;
}

export function attachTicketRemove(group: Command, deps: SharedDeps): void {
  group
    .command('remove')
    .description('remove a ticket from a draft sprint')
    .requiredOption('--sprint <id>', 'sprint id')
    .requiredOption('--ticket <id>', 'ticket id')
    .action(async (opts: TicketRemoveFlags) => {
      const code = await runTicketRemove(deps, opts);
      if (code !== EXIT_SUCCESS) process.exitCode = code;
    });
}

export async function runTicketRemove(deps: SharedDeps, opts: TicketRemoveFlags): Promise<ExitCode> {
  return runCommand({
    deps,
    body: async () => {
      const sprintId = SprintId.parse(opts.sprint);
      if (!sprintId.ok) return Result.error(sprintId.error);
      const ticketId = TicketId.parse(opts.ticket);
      if (!ticketId.ok) return Result.error(ticketId.error);
      const useCase = new RemoveTicketUseCase(deps.sprintRepo);
      return useCase.execute({
        sprintId: sprintId.value,
        ticketId: ticketId.value,
      });
    },
    format: () => `${c.green('removed ticket')} ${c.bold(opts.ticket)}`,
  });
}
