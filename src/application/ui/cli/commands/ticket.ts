import type { Command } from 'commander';
import type { Ticket } from '@src/domain/entity/ticket.ts';
import { TicketId } from '@src/domain/value/id/ticket-id.ts';
import { createTicketAddFlow } from '@src/application/flows/add-ticket/flow.ts';
import { createTicketPublishFlow } from '@src/application/flows/publish-ticket/flow.ts';
import { createTicketRemoveFlow } from '@src/application/flows/remove-ticket/flow.ts';
import { bootstrapCli } from '@src/application/ui/cli/bootstrap.ts';
import { plural } from '@src/application/ui/shared/plural.ts';
import { confirmDestructive } from '@src/application/ui/cli/confirm-destructive.ts';
import { fail } from '@src/application/ui/cli/report-cli-error.ts';
import {
  resolveSprintAndIdForCli,
  resolveSprintForCli,
  SPRINT_OPTION_DESC,
  SPRINT_OPTION_FLAGS,
  type SprintOpt,
} from '@src/application/ui/cli/resolve-sprint-selection.ts';

interface RemoveOpts extends SprintOpt {
  readonly yes?: boolean;
}

interface AddOpts extends SprintOpt {
  readonly title: string;
  readonly description?: string;
  readonly link?: string;
}

const listTicketsAction = async (opts: SprintOpt): Promise<void> => {
  const { deps, storage } = await bootstrapCli();
  const sprintId = await resolveSprintForCli(opts.sprint, storage.stateRoot);
  if (sprintId === undefined) return;
  const sprint = await deps.sprintRepo.findById(sprintId);
  if (!sprint.ok) {
    fail(sprint.error.message);
    return;
  }
  if (sprint.value.tickets.length === 0) {
    process.stdout.write('(no tickets on this sprint yet — add one with `ralphctl ticket add`)\n');
    return;
  }
  for (const t of sprint.value.tickets) {
    process.stdout.write(`${formatTicketLine(t)}\n`);
  }
};

const showTicketAction = async (rawTicketId: string, opts: SprintOpt): Promise<void> => {
  const { deps, storage } = await bootstrapCli();
  const ids = await resolveSprintAndIdForCli(opts.sprint, storage.stateRoot, rawTicketId, TicketId.parse, 'ticket');
  if (ids === undefined) return;
  const { sprintId, id: ticketId } = ids;
  const sprint = await deps.sprintRepo.findById(sprintId);
  if (!sprint.ok) {
    fail(sprint.error.message);
    return;
  }
  const found = sprint.value.tickets.find((t) => t.id === ticketId);
  if (!found) {
    fail(`ticket ${rawTicketId} not found on sprint ${String(sprintId)}`);
    return;
  }
  process.stdout.write(`${JSON.stringify(found, null, 2)}\n`);
};

const addTicketAction = async (opts: AddOpts): Promise<void> => {
  const { deps, storage } = await bootstrapCli();
  const sprintId = await resolveSprintForCli(opts.sprint, storage.stateRoot);
  if (sprintId === undefined) return;
  const flow = createTicketAddFlow({ sprintRepo: deps.sprintRepo });
  const result = await flow.execute({
    input: {
      sprintId: sprintId,
      title: opts.title,
      ...(opts.description !== undefined ? { description: opts.description } : {}),
      ...(opts.link !== undefined ? { link: opts.link } : {}),
    },
  });
  if (!result.ok) {
    fail(result.error.error.message);
    return;
  }
  const ticket = result.value.ctx.output!;
  process.stdout.write(`added ticket ${String(ticket.id)} to sprint ${String(sprintId)} — ${ticket.title}\n`);
};

const removeTicketAction = async (rawTicketId: string, opts: RemoveOpts): Promise<void> => {
  const { deps, storage } = await bootstrapCli();
  const ids = await resolveSprintAndIdForCli(opts.sprint, storage.stateRoot, rawTicketId, TicketId.parse, 'ticket');
  if (ids === undefined) return;
  const { sprintId, id: ticketId } = ids;

  const confirmed = await confirmDestructive({
    yes: opts.yes === true,
    action: `remove ticket ${rawTicketId}`,
    confirmPrompt: `remove ticket ${rawTicketId} from sprint ${String(sprintId)}? [y/N] `,
  });
  if (!confirmed) return;

  const flow = createTicketRemoveFlow({ sprintRepo: deps.sprintRepo });
  const result = await flow.execute({
    input: { sprintId: sprintId, ticketId: ticketId },
  });
  if (!result.ok) {
    fail(result.error.error.message);
    return;
  }
  const out = result.value.ctx.output!;
  if (!out.removed) {
    fail(`ticket ${rawTicketId} not found on sprint ${String(sprintId)}`);
    return;
  }
  process.stdout.write(
    `removed ticket ${rawTicketId} from sprint ${String(sprintId)} (${plural(out.remainingTickets, 'ticket')} remain)\n`
  );
};

const publishTicketAction = async (rawTicketId: string, opts: SprintOpt): Promise<void> => {
  const { deps, storage } = await bootstrapCli();
  const ids = await resolveSprintAndIdForCli(opts.sprint, storage.stateRoot, rawTicketId, TicketId.parse, 'ticket');
  if (ids === undefined) return;
  const { sprintId, id: ticketId } = ids;
  if (deps.issuePusher === undefined) {
    fail('issue tracker is unavailable');
    return;
  }

  const flow = createTicketPublishFlow({
    sprintRepo: deps.sprintRepo,
    projectRepo: deps.projectRepo,
    issuePusher: deps.issuePusher,
  });
  const result = await flow.execute({
    input: { sprintId: sprintId, ticketId: ticketId },
  });
  if (!result.ok) {
    fail(result.error.error.message);
    return;
  }
  const out = result.value.ctx.output!;
  process.stdout.write(`published ticket ${rawTicketId} on sprint ${String(sprintId)} — ${out.outcome}\n`);
};

/** Register the `ticket` command group. */
export const registerTicketCommand = (program: Command): void => {
  const ticketCmd = program.command('ticket').description('inspect and manage tickets within a sprint');

  ticketCmd
    .command('list')
    .description('list every ticket on the sprint')
    .option(SPRINT_OPTION_FLAGS, SPRINT_OPTION_DESC)
    .action(listTicketsAction);

  ticketCmd
    .command('show <ticketId>')
    .description('print a single ticket as JSON')
    .option(SPRINT_OPTION_FLAGS, SPRINT_OPTION_DESC)
    .action(showTicketAction);

  ticketCmd
    .command('add')
    .description('append a pending ticket to a draft sprint')
    .option(SPRINT_OPTION_FLAGS, SPRINT_OPTION_DESC)
    .requiredOption('-t, --title <title>', 'ticket title')
    .option('-d, --description <text>', 'optional description')
    .option('-l, --link <url>', 'optional issue link (http/https)')
    .action(addTicketAction);

  ticketCmd
    .command('publish <ticketId>')
    .description('create a tracker issue or post an approved-requirements comment')
    .option(SPRINT_OPTION_FLAGS, SPRINT_OPTION_DESC)
    .action(publishTicketAction);

  ticketCmd
    .command('remove <ticketId>')
    .description('drop a ticket from a draft sprint')
    .option(SPRINT_OPTION_FLAGS, SPRINT_OPTION_DESC)
    .option('-y, --yes', 'skip the interactive y/N confirmation')
    .action(removeTicketAction);
};

const formatTicketLine = (t: Ticket): string => {
  const linkSuffix = t.link !== undefined ? ` — ${String(t.link)}` : '';
  return `${String(t.id)}  [${t.status.padEnd(8)}]  ${t.title}${linkSuffix}`;
};
