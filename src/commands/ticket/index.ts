import { info, muted, error } from '@src/utils/colors.ts';
import { ticketAddCommand } from '@src/commands/ticket/add.ts';
import { ticketListCommand } from '@src/commands/ticket/list.ts';
import { ticketShowCommand } from '@src/commands/ticket/show.ts';
import { ticketRemoveCommand } from '@src/commands/ticket/remove.ts';

function showTicketUsage(): void {
  console.log(info('\nUsage: ralphctl ticket <command> [options]\n'));
  console.log(info('Commands:'));
  console.log('  add             Add ticket to active scope interactively');
  console.log('  list [-v]       List tickets (-v for full descriptions)');
  console.log('  show <id>       Show ticket details');
  console.log('  remove <id>     Remove ticket from scope');
  console.log(muted('\nExamples:'));
  console.log(muted('  $ ralphctl ticket add'));
  console.log(muted('  $ ralphctl ticket list -v'));
  console.log(muted('  $ ralphctl ticket show TICKET-001\n'));
}

export async function ticketCommand(args: string[]): Promise<void> {
  const subcommand = args[0];
  const subArgs = args.slice(1);

  switch (subcommand) {
    case 'add':
      await ticketAddCommand();
      break;
    case 'list':
      await ticketListCommand(subArgs);
      break;
    case 'show':
      await ticketShowCommand(subArgs);
      break;
    case 'remove':
      await ticketRemoveCommand(subArgs);
      break;
    case 'help':
    case '--help':
    case '-h':
    case undefined:
      showTicketUsage();
      break;
    default:
      console.log(error(`Unknown ticket command: ${subcommand}\n`));
      showTicketUsage();
      process.exit(1);
  }
}
