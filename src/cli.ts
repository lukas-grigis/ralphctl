import { highlight, muted, info, error } from '@src/utils/colors.ts';
import { helloCommand } from '@src/commands/hello.ts';
import { scopeCommand } from '@src/commands/scope/index.ts';
import { taskCommand } from '@src/commands/task/index.ts';
import { ticketCommand } from '@src/commands/ticket/index.ts';
import { progressCommand } from '@src/commands/progress/index.ts';

const BANNER = `
  ██████╗  █████╗ ██╗     ██████╗ ██╗  ██╗ ██████╗████████╗██╗
  ██╔══██╗██╔══██╗██║     ██╔══██╗██║  ██║██╔════╝╚══██╔══╝██║
  ██████╔╝███████║██║     ██████╔╝███████║██║        ██║   ██║
  ██╔══██╗██╔══██║██║     ██╔═══╝ ██╔══██║██║        ██║   ██║
  ██║  ██║██║  ██║███████╗██║     ██║  ██║╚██████╗   ██║   ███████╗
  ╚═╝  ╚═╝╚═╝  ╚═╝╚══════╝╚═╝     ╚═╝  ╚═╝ ╚═════╝   ╚═╝   ╚══════╝
`;

function showBanner(): void {
  console.log(highlight(BANNER));
  console.log(muted('  Scope & Task Management for AI-Assisted Coding\n'));
}

function showUsage(): void {
  console.log(info('Usage:'));
  console.log('  ralphctl <command> [subcommand] [options]\n');
  console.log(info('Commands:'));
  console.log('  scope     Manage scopes (create, list, show, activate, close, start)');
  console.log('  task      Manage tasks (add, list, show, remove, status, next, reorder)');
  console.log('  ticket    Manage tickets (add, list, remove)');
  console.log('  progress  Log and view progress (log, show)');
  console.log('  hello     Interactive greeting demo');
  console.log('  help      Show this help message\n');
  console.log(info('Examples:'));
  console.log(muted('  $ ralphctl scope create --name "My Scope"'));
  console.log(muted('  $ ralphctl scope activate'));
  console.log(muted('  $ ralphctl task add'));
  console.log(muted('  $ ralphctl scope start -i\n'));
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];
  const subArgs = args.slice(1);

  // Don't show banner for subcommands that produce structured output
  const quietCommands = ['task', 'ticket', 'progress'];
  if (!quietCommands.includes(command ?? '')) {
    showBanner();
  }

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    if (quietCommands.includes(command ?? '')) {
      showBanner();
    }
    showUsage();
    return;
  }

  switch (command) {
    case 'scope':
      await scopeCommand(subArgs);
      break;
    case 'task':
      await taskCommand(subArgs);
      break;
    case 'ticket':
      await ticketCommand(subArgs);
      break;
    case 'progress':
      await progressCommand(subArgs);
      break;
    case 'hello':
      await helloCommand();
      break;
    default:
      console.log(error(`Unknown command: ${command}\n`));
      showUsage();
      process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error(error('Fatal error:'), err);
  process.exit(1);
});
