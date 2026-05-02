/**
 * `ticket approve` — manually approve a ticket's requirements.
 *
 * Bypasses `sprint refine`'s AI clarification loop. Useful for tickets
 * that don't need refinement, or to recover from a failed refine run.
 */
import type { Command } from 'commander';
import * as c from 'colorette';

import { ApproveTicketRequirementsUseCase } from '@src/business/usecases/ticket/approve-ticket.ts';
import { Result } from '@src/domain/result.ts';
import { ValidationError } from '@src/domain/values/validation-error.ts';
import { SprintId } from '@src/domain/values/sprint-id.ts';
import { TicketId } from '@src/domain/values/ticket-id.ts';
import type { SharedDeps } from '@src/application/bootstrap/shared-deps.ts';
import { parseId, runCommand } from '@src/application/cli/command-runner.ts';
import { EXIT_SUCCESS, type ExitCode } from '@src/application/cli/exit-codes.ts';

interface TicketApproveFlags {
  readonly sprint: string;
  readonly ticket: string;
  readonly requirements: string;
}

export function attachTicketApprove(group: Command, deps: SharedDeps): void {
  group
    .command('approve')
    .description("manually approve a ticket's requirements (bypasses sprint refine)")
    .requiredOption('--sprint <id>', 'sprint id')
    .requiredOption('--ticket <id>', 'ticket id')
    .requiredOption('--requirements <text>', 'approved requirements text')
    .action(async (opts: TicketApproveFlags) => {
      const code = await runTicketApprove(deps, opts);
      if (code !== EXIT_SUCCESS) process.exitCode = code;
    });
}

async function runTicketApprove(deps: SharedDeps, opts: TicketApproveFlags): Promise<ExitCode> {
  return runCommand({
    deps,
    body: async () => {
      const sprintId = parseId(SprintId, opts.sprint);
      if (!sprintId.ok) return sprintId;
      const ticketId = parseId(TicketId, opts.ticket);
      if (!ticketId.ok) return ticketId;
      if (opts.requirements.trim().length === 0) {
        return Result.error(
          new ValidationError({
            field: 'requirements',
            value: opts.requirements,
            message: 'requirements must be a non-empty string',
          })
        );
      }
      const useCase = new ApproveTicketRequirementsUseCase(deps.sprintRepo);
      return useCase.execute({
        sprintId: sprintId.value,
        ticketId: ticketId.value,
        requirements: opts.requirements,
      });
    },
    format: () => `${c.green('approved')} ticket ${c.bold(opts.ticket)}`,
  });
}
