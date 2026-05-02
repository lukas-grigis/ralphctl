/**
 * `ticket edit` — change a draft ticket's title / description / link.
 *
 * Project scope is sprint-level — there is no per-ticket project field to
 * reassign. To move work between projects, create a new sprint scoped to
 * the target project.
 */
import type { Command } from 'commander';
import * as c from 'colorette';

import { EditTicketUseCase } from '@src/business/usecases/ticket/edit-ticket.ts';
import { SprintId } from '@src/domain/values/sprint-id.ts';
import { TicketId } from '@src/domain/values/ticket-id.ts';
import type { SharedDeps } from '@src/application/bootstrap/shared-deps.ts';
import { parseId, runCommand } from '@src/application/cli/command-runner.ts';
import { EXIT_SUCCESS, type ExitCode } from '@src/application/cli/exit-codes.ts';

interface TicketEditFlags {
  readonly sprint: string;
  readonly ticket: string;
  readonly title?: string;
  readonly description?: string;
  readonly link?: string;
}

export function attachTicketEdit(group: Command, deps: SharedDeps): void {
  group
    .command('edit')
    .description('edit a draft ticket')
    .requiredOption('--sprint <id>', 'sprint id')
    .requiredOption('--ticket <id>', 'ticket id')
    .option('--title <text>', 'new title')
    .option('--description <text>', 'new description (use empty string to clear)')
    .option('--link <url>', 'new link (use empty string to clear)')
    .action(async (opts: TicketEditFlags) => {
      const code = await runTicketEdit(deps, opts);
      if (code !== EXIT_SUCCESS) process.exitCode = code;
    });
}

export async function runTicketEdit(deps: SharedDeps, opts: TicketEditFlags): Promise<ExitCode> {
  return runCommand({
    deps,
    body: async () => {
      const sprintId = parseId(SprintId, opts.sprint);
      if (!sprintId.ok) return sprintId;
      const ticketId = parseId(TicketId, opts.ticket);
      if (!ticketId.ok) return ticketId;

      const useCase = new EditTicketUseCase(deps.sprintRepo);
      return useCase.execute({
        sprintId: sprintId.value,
        ticketId: ticketId.value,
        partial: {
          ...(opts.title !== undefined ? { title: opts.title } : {}),
          ...(opts.description !== undefined ? { description: opts.description } : {}),
          ...(opts.link !== undefined ? { link: opts.link } : {}),
        },
      });
    },
    format: () => `${c.green('updated ticket')} ${c.bold(opts.ticket)}`,
  });
}
