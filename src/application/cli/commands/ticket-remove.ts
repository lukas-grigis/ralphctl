/**
 * `ticket remove` — drop a ticket from a draft sprint.
 */
import type { Command } from 'commander';
import * as c from 'colorette';

import { RemoveTicketUseCase } from '@src/business/usecases/ticket/remove-ticket.ts';
import { SprintId } from '@src/domain/values/sprint-id.ts';
import { TicketId } from '@src/domain/values/ticket-id.ts';
import type { SharedDeps } from '@src/application/bootstrap/shared-deps.ts';
import { parseId, runCommand } from '@src/application/cli/command-runner.ts';
import { EXIT_SUCCESS, type ExitCode } from '@src/application/cli/exit-codes.ts';

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
      const sprintId = parseId(SprintId, opts.sprint);
      if (!sprintId.ok) return sprintId;
      const ticketId = parseId(TicketId, opts.ticket);
      if (!ticketId.ok) return ticketId;
      const useCase = new RemoveTicketUseCase(deps.sprintRepo);
      return useCase.execute({
        sprintId: sprintId.value,
        ticketId: ticketId.value,
      });
    },
    format: () => `${c.green('removed ticket')} ${c.bold(opts.ticket)}`,
  });
}
