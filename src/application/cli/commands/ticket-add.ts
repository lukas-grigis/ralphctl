/**
 * `ticket add` — append a new ticket to a draft sprint.
 */
import type { Command } from 'commander';
import * as c from 'colorette';

import { AddTicketUseCase } from '../../../business/usecases/ticket/add-ticket.ts';
import { ProjectName } from '../../../domain/values/project-name.ts';
import { SprintId } from '../../../domain/values/sprint-id.ts';
import type { SharedDeps } from '../../bootstrap/shared-deps.ts';
import { parseId, runCommand } from '../command-runner.ts';
import { EXIT_SUCCESS, type ExitCode } from '../exit-codes.ts';

interface TicketAddFlags {
  readonly sprint: string;
  readonly project: string;
  readonly title: string;
  readonly description?: string;
  readonly link?: string;
}

export function attachTicketAdd(group: Command, deps: SharedDeps): void {
  group
    .command('add')
    .description('add a ticket to a draft sprint')
    .requiredOption('--sprint <id>', 'target sprint id')
    .requiredOption('--project <name>', 'project name the ticket belongs to')
    .requiredOption('--title <text>', 'ticket title')
    .option('--description <text>', 'optional description')
    .option('--link <url>', 'optional issue tracker URL')
    .action(async (opts: TicketAddFlags) => {
      const code = await runTicketAdd(deps, opts);
      if (code !== EXIT_SUCCESS) process.exitCode = code;
    });
}

export async function runTicketAdd(deps: SharedDeps, opts: TicketAddFlags): Promise<ExitCode> {
  return runCommand({
    deps,
    body: async () => {
      const sprintId = parseId(SprintId, opts.sprint);
      if (!sprintId.ok) return sprintId;
      const projectName = parseId(ProjectName, opts.project);
      if (!projectName.ok) return projectName;

      const useCase = new AddTicketUseCase(deps.sprintRepo);
      return useCase.execute({
        sprintId: sprintId.value,
        ticketInput: {
          title: opts.title,
          projectName: projectName.value,
          ...(opts.description !== undefined ? { description: opts.description } : {}),
          ...(opts.link !== undefined ? { link: opts.link } : {}),
        },
      });
    },
    format: (_d, sprint) => {
      const last = sprint.tickets[sprint.tickets.length - 1];
      const id = last ? last.id : '?';
      return `${c.green('added ticket')} ${c.bold(id)} to sprint ${c.dim(sprint.id)}`;
    },
  });
}
