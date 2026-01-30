import { info, muted, error } from '@src/utils/colors.ts';
import { progressLogCommand } from '@src/commands/progress/log.ts';
import { progressShowCommand } from '@src/commands/progress/show.ts';

function showProgressUsage(): void {
  console.log(info('\nUsage: ralphctl progress <command> [options]\n'));
  console.log(info('Commands:'));
  console.log('  log [message]    Append to progress.md (opens editor if no message)');
  console.log('  show             Display progress.md content');
  console.log(muted('\nExamples:'));
  console.log(muted('  $ ralphctl progress log "Completed user authentication"'));
  console.log(muted('  $ ralphctl progress show\n'));
}

export async function progressCommand(args: string[]): Promise<void> {
  const subcommand = args[0];
  const subArgs = args.slice(1);

  switch (subcommand) {
    case 'log':
      await progressLogCommand(subArgs);
      break;
    case 'show':
      await progressShowCommand();
      break;
    case 'help':
    case '--help':
    case '-h':
    case undefined:
      showProgressUsage();
      break;
    default:
      console.log(error(`Unknown progress command: ${subcommand}\n`));
      showProgressUsage();
      process.exit(1);
  }
}
