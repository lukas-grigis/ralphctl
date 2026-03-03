import { Command } from 'commander';
import { showBanner } from '@src/theme/ui.ts';
import { interactiveMode } from '@src/interactive/index.ts';
import { registerProjectCommands } from '@src/commands/project/index.ts';
import { registerSprintCommands } from '@src/commands/sprint/index.ts';
import { registerTaskCommands } from '@src/commands/task/index.ts';
import { registerTicketCommands } from '@src/commands/ticket/index.ts';
import { registerProgressCommands } from '@src/commands/progress/index.ts';
import { registerDashboardCommands } from '@src/commands/dashboard/index.ts';
import { registerConfigCommands } from '@src/commands/config/index.ts';
import { registerCompletionCommands } from '@src/commands/completion/index.ts';
import { registerDoctorCommands } from '@src/commands/doctor/index.ts';
import { error } from '@src/theme/index.ts';
import { cliMetadata } from '@src/cli-metadata.ts';

const program = new Command();
program
  .name(cliMetadata.name)
  .description(cliMetadata.description)
  .version(cliMetadata.version)
  .addHelpText(
    'after',
    `
Examples:
  $ ralphctl                              # Interactive mode
  $ ralphctl status                       # Show current sprint status
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
registerDashboardCommands(program);
registerConfigCommands(program);
registerCompletionCommands(program);
registerDoctorCommands(program);

async function main(): Promise<void> {
  // Shell completion: intercept before any output (banner, interactive mode)
  if (process.env['COMP_CWORD'] && process.env['COMP_POINT'] && process.env['COMP_LINE']) {
    const { handleCompletionRequest } = await import('@src/completion/handle.ts');
    if (await handleCompletionRequest(program)) return;
  }

  // No args or 'interactive' → interactive mode
  if (process.argv.length <= 2 || process.argv[2] === 'interactive') {
    // Interactive mode shows its own banner
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
