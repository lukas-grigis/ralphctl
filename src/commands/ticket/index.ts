import type { Command } from 'commander';
import { ticketAddCommand } from '@src/commands/ticket/add.ts';
import { ticketEditCommand } from '@src/commands/ticket/edit.ts';
import { ticketListCommand } from '@src/commands/ticket/list.ts';
import { ticketShowCommand } from '@src/commands/ticket/show.ts';
import { ticketRemoveCommand } from '@src/commands/ticket/remove.ts';
import { ticketRefineCommand } from '@src/commands/ticket/refine.ts';

export function registerTicketCommands(program: Command): void {
  const ticket = program.command('ticket').description('Manage tickets');

  ticket.addHelpText(
    'after',
    `
Examples:
  $ ralphctl ticket add --project api --title "Fix auth bug"
  $ ralphctl ticket edit abc123 --title "New title"
  $ ralphctl ticket list -b
  $ ralphctl ticket show abc123
`
  );

  ticket
    .command('add')
    .description('Add ticket to current sprint')
    .option('-p, --project <name>', 'Project name')
    .option('-t, --title <title>', 'Ticket title')
    .option('-d, --description <desc>', 'Description')
    .option('--link <url>', 'Link to external issue')
    .option('-n, --no-interactive', 'Non-interactive mode (error on missing params)')
    .action(
      async (opts: {
        project?: string;
        title?: string;
        description?: string;
        link?: string;
        interactive?: boolean;
      }) => {
        await ticketAddCommand({
          project: opts.project,
          title: opts.title,
          description: opts.description,
          link: opts.link,
          // --no-interactive sets interactive=false, otherwise true (prompt for missing)
          interactive: opts.interactive !== false,
        });
      }
    );

  ticket
    .command('edit [id]')
    .description('Edit an existing ticket')
    .option('--title <title>', 'New title')
    .option('--description <desc>', 'New description')
    .option('--link <url>', 'New link')
    .option('-n, --no-interactive', 'Non-interactive mode')
    .action(
      async (
        id?: string,
        opts?: {
          title?: string;
          description?: string;
          link?: string;
          interactive?: boolean;
        }
      ) => {
        await ticketEditCommand(id, {
          title: opts?.title,
          description: opts?.description,
          link: opts?.link,
          interactive: opts?.interactive !== false,
        });
      }
    );

  ticket
    .command('list')
    .description('List tickets')
    .option('-b, --brief', 'Brief one-liner format')
    .option('--project <name>', 'Filter by project')
    .option('--status <status>', 'Filter by requirement status (pending, approved)')
    .action(async (opts: { brief?: boolean; project?: string; status?: string }) => {
      const args: string[] = [];
      if (opts.brief) args.push('-b');
      if (opts.project) args.push('--project', opts.project);
      if (opts.status) args.push('--status', opts.status);
      await ticketListCommand(args);
    });

  ticket
    .command('show [id]')
    .description('Show ticket details')
    .action(async (id?: string) => {
      await ticketShowCommand(id ? [id] : []);
    });

  ticket
    .command('refine [id]')
    .description('Re-refine an approved ticket')
    .action(async (id?: string) => {
      await ticketRefineCommand(id);
    });

  ticket
    .command('remove [id]')
    .description('Remove a ticket')
    .option('-y, --yes', 'Skip confirmation')
    .action(async (id?: string, opts?: { yes?: boolean }) => {
      const args: string[] = [];
      if (id) args.push(id);
      if (opts?.yes) args.push('-y');
      await ticketRemoveCommand(args);
    });
}
