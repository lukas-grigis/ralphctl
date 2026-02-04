import { Command } from 'commander';
import { showBanner } from '@src/theme/ui.ts';
import { interactiveMode } from '@src/interactive/index.ts';
import { registerProjectCommands } from '@src/commands/project/index.ts';
import { registerSprintCommands } from '@src/commands/sprint/index.ts';
import { registerTaskCommands } from '@src/commands/task/index.ts';
import { registerTicketCommands } from '@src/commands/ticket/index.ts';
import { registerProgressCommands } from '@src/commands/progress/index.ts';
import { error } from '@src/theme/index.ts';

const program = new Command();
program
  .name('ralphctl')
  .description('Sprint & task management for AI-assisted coding')
  .version('0.1.0')
  .addHelpText(
    'after',
    `
Examples:
  $ ralphctl                              # Interactive mode
  $ ralphctl sprint create --name "v1.0"  # Create sprint
  $ ralphctl ticket add --project api     # Add ticket
  $ ralphctl task list -b                 # Brief task list

Run any command with --help for details.
`
  );

registerProjectCommands(program);
registerSprintCommands(program);
registerTaskCommands(program);
registerTicketCommands(program);
registerProgressCommands(program);

async function main(): Promise<void> {
  // No args or 'interactive' → interactive mode
  if (process.argv.length <= 2 || process.argv[2] === 'interactive') {
    showBanner();
    await interactiveMode();
  } else {
    showBanner();
    await program.parseAsync(process.argv);
  }
}

main().catch((err: unknown) => {
  console.error(error('Fatal error:'), err);
  process.exit(1);
});
