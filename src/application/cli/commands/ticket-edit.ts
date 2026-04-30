/**
 * `ticket edit` — change a draft ticket's title / description / link / project.
 */
import type { Command } from 'commander';
import * as c from 'colorette';

import { EditTicketUseCase } from '../../../business/usecases/ticket/edit-ticket.ts';
import { Result } from '../../../domain/result.ts';
import { ProjectName } from '../../../domain/values/project-name.ts';
import { SprintId } from '../../../domain/values/sprint-id.ts';
import { TicketId } from '../../../domain/values/ticket-id.ts';
import type { SharedDeps } from '../../bootstrap/shared-deps.ts';
import { runCommand } from '../command-runner.ts';
import { EXIT_SUCCESS, type ExitCode } from '../exit-codes.ts';

interface TicketEditFlags {
  readonly sprint: string;
  readonly ticket: string;
  readonly title?: string;
  readonly description?: string;
  readonly link?: string;
  readonly project?: string;
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
    .option('--project <name>', 'reassign to a different project')
    .action(async (opts: TicketEditFlags) => {
      const code = await runTicketEdit(deps, opts);
      if (code !== EXIT_SUCCESS) process.exitCode = code;
    });
}

export async function runTicketEdit(deps: SharedDeps, opts: TicketEditFlags): Promise<ExitCode> {
  return runCommand({
    deps,
    body: async () => {
      const sprintId = SprintId.parse(opts.sprint);
      if (!sprintId.ok) return Result.error(sprintId.error);
      const ticketId = TicketId.parse(opts.ticket);
      if (!ticketId.ok) return Result.error(ticketId.error);

      let projectName: import('../../../domain/values/project-name.ts').ProjectName | undefined;
      if (opts.project !== undefined) {
        const parsed = ProjectName.parse(opts.project);
        if (!parsed.ok) return Result.error(parsed.error);
        projectName = parsed.value;
      }

      const useCase = new EditTicketUseCase(deps.sprintRepo);
      return useCase.execute({
        sprintId: sprintId.value,
        ticketId: ticketId.value,
        partial: {
          ...(opts.title !== undefined ? { title: opts.title } : {}),
          ...(opts.description !== undefined ? { description: opts.description } : {}),
          ...(opts.link !== undefined ? { link: opts.link } : {}),
          ...(projectName !== undefined ? { projectName } : {}),
        },
      });
    },
    format: () => `${c.green('updated ticket')} ${c.bold(opts.ticket)}`,
  });
}
