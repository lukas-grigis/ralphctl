import type { Command } from 'commander';
import type { Ticket } from '@src/domain/entity/ticket.ts';
import { TicketId } from '@src/domain/value/id/ticket-id.ts';
import { createTicketAddFlow } from '@src/application/flows/add-ticket/flow.ts';
import { createTicketRemoveFlow } from '@src/application/flows/remove-ticket/flow.ts';
import { bootstrapCli } from '@src/application/ui/cli/bootstrap.ts';
import { confirmDestructive } from '@src/application/ui/cli/confirm-destructive.ts';
import { pinFallbackNotice, resolveSprintId } from '@src/application/ui/cli/resolve-sprint-selection.ts';

interface SprintOpt {
  readonly sprint?: string;
}

interface RemoveOpts extends SprintOpt {
  readonly yes?: boolean;
}

const SPRINT_OPTION_FLAGS = '-s, --sprint <id>';
const SPRINT_OPTION_DESC = 'sprint id (defaults to the current sprint)';

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
 *   ralphctl ticket list   [--sprint <id>]
 *   ralphctl ticket show   [--sprint <id>] <ticket-id>
 *   ralphctl ticket add    [--sprint <id>] --title <title> [--description <text>] [--link <url>]
 *   ralphctl ticket remove [--sprint <id>] <ticket-id>
 *
 * `--sprint` defaults to the pinned current sprint (`ralphctl sprint set-current <id>` or any
 * TUI sprint pick); the fallback path prints a one-line stderr notice naming the substituted
 * sprint, and the add/remove success lines always name the resolved sprint so the mutation
 * target is never ambiguous. A stale pin fails naturally downstream (`findById` not-found /
 * the only-when-draft invariant).
 */
export const registerTicketCommand = (program: Command): void => {
  const ticketCmd = program.command('ticket').description('inspect and manage tickets within a sprint');

  ticketCmd
    .command('list')
    .description('list every ticket on the sprint')
    .option(SPRINT_OPTION_FLAGS, SPRINT_OPTION_DESC)
    .action(async (opts: SprintOpt) => {
      const { deps, storage } = await bootstrapCli();
      const sprintId = await resolveSprintId(opts.sprint, storage.stateRoot);
      if (!sprintId.ok) {
        process.stderr.write(`error: ${sprintId.error.message}\n`);
        process.exitCode = 1;
        return;
      }
      if (sprintId.value.fromPin) process.stderr.write(pinFallbackNotice(sprintId.value.sprintId));
      const sprint = await deps.sprintRepo.findById(sprintId.value.sprintId);
      if (!sprint.ok) {
        process.stderr.write(`error: ${sprint.error.message}\n`);
        process.exitCode = 1;
        return;
      }
      if (sprint.value.tickets.length === 0) {
        process.stdout.write('(no tickets on this sprint yet — add one with `ralphctl ticket add`)\n');
        return;
      }
      for (const t of sprint.value.tickets) {
        process.stdout.write(`${formatTicketLine(t)}\n`);
      }
    });

  ticketCmd
    .command('show <ticketId>')
    .description('print a single ticket as JSON')
    .option(SPRINT_OPTION_FLAGS, SPRINT_OPTION_DESC)
    .action(async (rawTicketId: string, opts: SprintOpt) => {
      const { deps, storage } = await bootstrapCli();
      const sprintId = await resolveSprintId(opts.sprint, storage.stateRoot);
      if (!sprintId.ok) {
        process.stderr.write(`error: ${sprintId.error.message}\n`);
        process.exitCode = 1;
        return;
      }
      const ticketId = TicketId.parse(rawTicketId);
      if (!ticketId.ok) {
        process.stderr.write(`error: invalid ticket id: ${ticketId.error.message}\n`);
        process.exitCode = 1;
        return;
      }
      if (sprintId.value.fromPin) process.stderr.write(pinFallbackNotice(sprintId.value.sprintId));
      const sprint = await deps.sprintRepo.findById(sprintId.value.sprintId);
      if (!sprint.ok) {
        process.stderr.write(`error: ${sprint.error.message}\n`);
        process.exitCode = 1;
        return;
      }
      const found = sprint.value.tickets.find((t) => t.id === ticketId.value);
      if (!found) {
        process.stderr.write(`error: ticket ${rawTicketId} not found on sprint ${String(sprintId.value.sprintId)}\n`);
        process.exitCode = 1;
        return;
      }
      process.stdout.write(`${JSON.stringify(found, null, 2)}\n`);
    });

  ticketCmd
    .command('add')
    .description('append a pending ticket to a draft sprint')
    .option(SPRINT_OPTION_FLAGS, SPRINT_OPTION_DESC)
    .requiredOption('-t, --title <title>', 'ticket title')
    .option('-d, --description <text>', 'optional description')
    .option('-l, --link <url>', 'optional issue link (http/https)')
    .action(async (opts: AddOpts) => {
      const { deps, storage } = await bootstrapCli();
      const sprintId = await resolveSprintId(opts.sprint, storage.stateRoot);
      if (!sprintId.ok) {
        process.stderr.write(`error: ${sprintId.error.message}\n`);
        process.exitCode = 1;
        return;
      }
      if (sprintId.value.fromPin) process.stderr.write(pinFallbackNotice(sprintId.value.sprintId));
      const flow = createTicketAddFlow({ sprintRepo: deps.sprintRepo });
      const result = await flow.execute({
        input: {
          sprintId: sprintId.value.sprintId,
          title: opts.title,
          ...(opts.description !== undefined ? { description: opts.description } : {}),
          ...(opts.link !== undefined ? { link: opts.link } : {}),
        },
      });
      if (!result.ok) {
        process.stderr.write(`error: ${result.error.error.message}\n`);
        process.exitCode = 1;
        return;
      }
      const ticket = result.value.ctx.output!;
      process.stdout.write(
        `added ticket ${String(ticket.id)} to sprint ${String(sprintId.value.sprintId)} — ${ticket.title}\n`
      );
    });

  ticketCmd
    .command('remove <ticketId>')
    .description('drop a ticket from a draft sprint')
    .option(SPRINT_OPTION_FLAGS, SPRINT_OPTION_DESC)
    .option('-y, --yes', 'skip the interactive y/N confirmation')
    .action(async (rawTicketId: string, opts: RemoveOpts) => {
      const { deps, storage } = await bootstrapCli();
      const sprintId = await resolveSprintId(opts.sprint, storage.stateRoot);
      if (!sprintId.ok) {
        process.stderr.write(`error: ${sprintId.error.message}\n`);
        process.exitCode = 1;
        return;
      }
      const ticketId = TicketId.parse(rawTicketId);
      if (!ticketId.ok) {
        process.stderr.write(`error: invalid ticket id: ${ticketId.error.message}\n`);
        process.exitCode = 1;
        return;
      }
      if (sprintId.value.fromPin) process.stderr.write(pinFallbackNotice(sprintId.value.sprintId));

      const confirmed = await confirmDestructive({
        yes: opts.yes === true,
        action: `remove ticket ${rawTicketId}`,
        confirmPrompt: `remove ticket ${rawTicketId} from sprint ${String(sprintId.value.sprintId)}? [y/N] `,
      });
      if (!confirmed) return;

      const flow = createTicketRemoveFlow({ sprintRepo: deps.sprintRepo });
      const result = await flow.execute({
        input: { sprintId: sprintId.value.sprintId, ticketId: ticketId.value },
      });
      if (!result.ok) {
        process.stderr.write(`error: ${result.error.error.message}\n`);
        process.exitCode = 1;
        return;
      }
      const out = result.value.ctx.output!;
      if (!out.removed) {
        process.stderr.write(`error: ticket ${rawTicketId} not found on sprint ${String(sprintId.value.sprintId)}\n`);
        process.exitCode = 1;
        return;
      }
      process.stdout.write(
        `removed ticket ${rawTicketId} from sprint ${String(sprintId.value.sprintId)} (${String(out.remainingTickets)} ticket${out.remainingTickets === 1 ? '' : 's'} remain)\n`
      );
    });
};

const formatTicketLine = (t: Ticket): string => {
  const linkSuffix = t.link !== undefined ? ` — ${String(t.link)}` : '';
  return `${String(t.id)}  [${t.status.padEnd(8)}]  ${t.title}${linkSuffix}`;
};
