import { info, muted, error } from '@src/utils/colors.ts';
import { scopeCreateCommand } from '@src/commands/scope/create.ts';
import { scopeListCommand } from '@src/commands/scope/list.ts';
import { scopeShowCommand } from '@src/commands/scope/show.ts';
import { scopeContextCommand } from '@src/commands/scope/context.ts';
import { scopeActivateCommand } from '@src/commands/scope/activate.ts';
import { scopeCloseCommand } from '@src/commands/scope/close.ts';
import { scopeStartCommand } from '@src/commands/scope/start.ts';

function showScopeUsage(): void {
  console.log(info('\nUsage: ralphctl scope <command> [options]\n'));
  console.log(info('Commands:'));
  console.log('  create [--name <name>]  Create a new scope');
  console.log('  list                    List all scopes');
  console.log('  show [id]               Show scope details (defaults to active)');
  console.log('  context [id]            Output full context for planning');
  console.log('  activate [id]           Activate a draft scope');
  console.log('  close [id]              Close an active scope');
  console.log('  start [id] [options]    Run automated implementation loop');
  console.log(info('\nStart options:'));
  console.log('  -i, --interactive       Pause after each task');
  console.log('  -n, --count <N>         Implement only N tasks');
  console.log(muted('\nExamples:'));
  console.log(muted('  $ ralphctl scope create'));
  console.log(muted('  $ ralphctl scope context'));
  console.log(muted('  $ ralphctl scope start -i -n 3\n'));
}

export async function scopeCommand(args: string[]): Promise<void> {
  const subcommand = args[0];
  const subArgs = args.slice(1);

  switch (subcommand) {
    case 'create':
      await scopeCreateCommand(subArgs);
      break;
    case 'list':
      await scopeListCommand();
      break;
    case 'show':
      await scopeShowCommand(subArgs);
      break;
    case 'context':
      await scopeContextCommand(subArgs);
      break;
    case 'activate':
      await scopeActivateCommand(subArgs);
      break;
    case 'close':
      await scopeCloseCommand(subArgs);
      break;
    case 'start':
      await scopeStartCommand(subArgs);
      break;
    case 'help':
    case '--help':
    case '-h':
    case undefined:
      showScopeUsage();
      break;
    default:
      console.log(error(`Unknown scope command: ${subcommand}\n`));
      showScopeUsage();
      process.exit(1);
  }
}
