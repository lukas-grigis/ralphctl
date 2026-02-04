import type { Command } from 'commander';
import { ticketAddCommand } from '@src/commands/ticket/add.ts';
import { ticketEditCommand } from '@src/commands/ticket/edit.ts';
import { ticketListCommand } from '@src/commands/ticket/list.ts';
import { ticketShowCommand } from '@src/commands/ticket/show.ts';
import { ticketRemoveCommand } from '@src/commands/ticket/remove.ts';

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
    .option('--project <name>', 'Project name')
    .option('--id <id>', 'External ticket ID (e.g., JIRA-123)')
    .option('--title <title>', 'Ticket title')
    .option('--description <desc>', 'Description')
    .option('--link <url>', 'Link to external issue')
    .option('--editor', 'Use editor for multi-line description')
    .option('-n, --no-interactive', 'Non-interactive mode (error on missing params)')
    .action(
      async (opts: {
        project?: string;
        id?: string;
        title?: string;
        description?: string;
        link?: string;
        editor?: boolean;
        interactive?: boolean;
      }) => {
        await ticketAddCommand({
          project: opts.project,
          externalId: opts.id,
          title: opts.title,
          description: opts.description,
          link: opts.link,
          useEditor: opts.editor,
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
    .option('--id <id>', 'New external ID')
    .option('-n, --no-interactive', 'Non-interactive mode')
    .action(
      async (
        id?: string,
        opts?: {
          title?: string;
          description?: string;
          link?: string;
          id?: string;
          interactive?: boolean;
        }
      ) => {
        await ticketEditCommand(id, {
          title: opts?.title,
          description: opts?.description,
          link: opts?.link,
          externalId: opts?.id,
          interactive: opts?.interactive !== false,
        });
      }
    );

  ticket
    .command('list')
    .description('List tickets')
    .option('-b, --brief', 'Brief one-liner format')
    .action(async (opts: { brief?: boolean }) => {
      await ticketListCommand(opts.brief ? ['-b'] : []);
    });

  ticket
    .command('show [id]')
    .description('Show ticket details')
    .action(async (id?: string) => {
      await ticketShowCommand(id ? [id] : []);
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
