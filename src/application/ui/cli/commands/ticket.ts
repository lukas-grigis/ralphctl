import type { Command } from 'commander';
import type { Ticket } from '@src/domain/entity/ticket.ts';
import { TicketId } from '@src/domain/value/id/ticket-id.ts';
import { SprintId } from '@src/domain/value/id/sprint-id.ts';
import { createTicketAddFlow } from '@src/application/flows/add-ticket/flow.ts';
import { createTicketRemoveFlow } from '@src/application/flows/remove-ticket/flow.ts';
import { bootstrapCli } from '@src/application/ui/cli/bootstrap.ts';

interface SprintOpt {
  readonly sprint: string;
}

interface AddOpts extends SprintOpt {
  readonly title: string;
  readonly description?: string;
  readonly link?: string;
}

/**
 * Register the `ticket` command group. Tickets are nested in the Sprint aggregate (no separate
 * repo), so list/show route through `sprintRepo.findById` directly; add/remove dispatch to
 * use-cases because they carry domain invariants (only-when-draft, conflict on duplicate id).
 *
 *   ralphctl ticket list   --sprint <id>
 *   ralphctl ticket show   --sprint <id> <ticket-id>
 *   ralphctl ticket add    --sprint <id> --title <title> [--description <text>] [--link <url>]
 *   ralphctl ticket remove --sprint <id> <ticket-id>
 */
export const registerTicketCommand = (program: Command): void => {
  const ticketCmd = program.command('ticket').description('inspect and manage tickets within a sprint');

  ticketCmd
    .command('list')
    .description('list every ticket on the sprint')
    .requiredOption('-s, --sprint <id>', 'sprint id')
    .action(async (opts: SprintOpt) => {
      const sprintId = SprintId.parse(opts.sprint);
      if (!sprintId.ok) {
        process.stderr.write(`error: invalid sprint id: ${sprintId.error.message}\n`);
        process.exit(1);
        return;
      }
      const { deps } = await bootstrapCli();
      const sprint = await deps.sprintRepo.findById(sprintId.value);
      if (!sprint.ok) {
        process.stderr.write(`error: ${sprint.error.message}\n`);
        process.exit(1);
        return;
      }
      if (sprint.value.tickets.length === 0) {
        process.stdout.write('(no tickets on this sprint yet)\n');
        return;
      }
      for (const t of sprint.value.tickets) {
        process.stdout.write(`${formatTicketLine(t)}\n`);
      }
    });

  ticketCmd
    .command('show <ticketId>')
    .description('print a single ticket as JSON')
    .requiredOption('-s, --sprint <id>', 'sprint id')
    .action(async (rawTicketId: string, opts: SprintOpt) => {
      const sprintId = SprintId.parse(opts.sprint);
      if (!sprintId.ok) {
        process.stderr.write(`error: invalid sprint id: ${sprintId.error.message}\n`);
        process.exit(1);
        return;
      }
      const ticketId = TicketId.parse(rawTicketId);
      if (!ticketId.ok) {
        process.stderr.write(`error: invalid ticket id: ${ticketId.error.message}\n`);
        process.exit(1);
        return;
      }
      const { deps } = await bootstrapCli();
      const sprint = await deps.sprintRepo.findById(sprintId.value);
      if (!sprint.ok) {
        process.stderr.write(`error: ${sprint.error.message}\n`);
        process.exit(1);
        return;
      }
      const found = sprint.value.tickets.find((t) => t.id === ticketId.value);
      if (!found) {
        process.stderr.write(`error: ticket ${rawTicketId} not found on sprint ${opts.sprint}\n`);
        process.exit(1);
        return;
      }
      process.stdout.write(`${JSON.stringify(found, null, 2)}\n`);
    });

  ticketCmd
    .command('add')
    .description('append a pending ticket to a draft sprint')
    .requiredOption('-s, --sprint <id>', 'sprint id')
    .requiredOption('-t, --title <title>', 'ticket title')
    .option('-d, --description <text>', 'optional description')
    .option('-l, --link <url>', 'optional issue link (http/https)')
    .action(async (opts: AddOpts) => {
      const sprintId = SprintId.parse(opts.sprint);
      if (!sprintId.ok) {
        process.stderr.write(`error: invalid sprint id: ${sprintId.error.message}\n`);
        process.exit(1);
        return;
      }
      const { deps } = await bootstrapCli();
      const flow = createTicketAddFlow({ sprintRepo: deps.sprintRepo });
      const result = await flow.execute({
        input: {
          sprintId: sprintId.value,
          title: opts.title,
          ...(opts.description !== undefined ? { description: opts.description } : {}),
          ...(opts.link !== undefined ? { link: opts.link } : {}),
        },
      });
      if (!result.ok) {
        process.stderr.write(`error: ${result.error.error.message}\n`);
        process.exit(1);
        return;
      }
      const ticket = result.value.ctx.output!;
      process.stdout.write(`added ticket ${String(ticket.id)} — ${ticket.title}\n`);
    });

  ticketCmd
    .command('remove <ticketId>')
    .description('drop a ticket from a draft sprint')
    .requiredOption('-s, --sprint <id>', 'sprint id')
    .action(async (rawTicketId: string, opts: SprintOpt) => {
      const sprintId = SprintId.parse(opts.sprint);
      if (!sprintId.ok) {
        process.stderr.write(`error: invalid sprint id: ${sprintId.error.message}\n`);
        process.exit(1);
        return;
      }
      const ticketId = TicketId.parse(rawTicketId);
      if (!ticketId.ok) {
        process.stderr.write(`error: invalid ticket id: ${ticketId.error.message}\n`);
        process.exit(1);
        return;
      }
      const { deps } = await bootstrapCli();
      const flow = createTicketRemoveFlow({ sprintRepo: deps.sprintRepo });
      const result = await flow.execute({
        input: { sprintId: sprintId.value, ticketId: ticketId.value },
      });
      if (!result.ok) {
        process.stderr.write(`error: ${result.error.error.message}\n`);
        process.exit(1);
        return;
      }
      const out = result.value.ctx.output!;
      if (!out.removed) {
        process.stderr.write(`error: ticket ${rawTicketId} not found on sprint ${opts.sprint}\n`);
        process.exit(1);
        return;
      }
      process.stdout.write(
        `removed ticket ${rawTicketId} (${String(out.remainingTickets)} ticket${out.remainingTickets === 1 ? '' : 's'} remain)\n`
      );
    });
};

const formatTicketLine = (t: Ticket): string => {
  const linkSuffix = t.link !== undefined ? ` — ${String(t.link)}` : '';
  return `${String(t.id)}  [${t.status.padEnd(8)}]  ${t.title}${linkSuffix}`;
};
