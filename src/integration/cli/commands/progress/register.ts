import type { Command } from 'commander';
import { progressLogCommand } from '@src/integration/cli/commands/progress/log.ts';
import { progressShowCommand } from '@src/integration/cli/commands/progress/show.ts';

export function registerProgressCommands(program: Command): void {
  const progress = program.command('progress').description('Log and view progress');

  progress.addHelpText(
    'after',
    `
Examples:
  $ ralphctl progress log "Completed auth flow"
  $ ralphctl progress show
`
  );

  progress
    .command('log [message]')
    .description('Append to progress log (opens editor if no message)')
    .action(async (message?: string) => {
      await progressLogCommand(message ? [message] : []);
    });

  progress.command('show').description('Display progress log').action(progressShowCommand);
}
