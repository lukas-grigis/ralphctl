import { Command } from 'commander';
import { launchTui } from '@src/application/ui/tui/launch.ts';
import { registerExportRequirementsCommand } from '@src/application/ui/cli/commands/export-requirements.ts';
import { registerExportContextCommand } from '@src/application/ui/cli/commands/export-context.ts';
import { registerCreatePrCommand } from '@src/application/ui/cli/commands/create-pr.ts';
import { registerDoctorCommand } from '@src/application/ui/cli/commands/doctor.ts';
import { registerSettingsCommand } from '@src/application/ui/cli/commands/settings.ts';
import { registerCompletionCommand } from '@src/application/ui/cli/commands/completion.ts';
import { registerProjectCommand } from '@src/application/ui/cli/commands/project.ts';
import { registerSprintCommand } from '@src/application/ui/cli/commands/sprint.ts';
import { registerTicketCommand } from '@src/application/ui/cli/commands/ticket.ts';
import { registerTaskCommand } from '@src/application/ui/cli/commands/task.ts';
import { registerRunsCommand } from '@src/application/ui/cli/commands/runs.ts';
import { CLI_METADATA } from '@src/business/version/cli-metadata.ts';

/**
 * Build and run the CLI. The default action (no subcommand) launches the
 * interactive TUI; named subcommands run a single flow against the wired
 * bootstrap (see `bootstrap.ts`).
 *
 * Long-running chain flows (implement / refine / plan / review / etc.) are
 * not CLI-accessible — their parameters require interactive context that
 * lives in the TUI runtime. See `docs/api.md` for the full surface.
 */
export const runCli = async (argv: readonly string[]): Promise<void> => {
  const program = new Command();

  program
    .name('ralphctl')
    .description('ralphctl — interactive TUI and CLI')
    .version(CLI_METADATA.currentVersion, '-v, --version', 'show version')
    .action(async () => {
      await launchTui();
    });

  registerExportRequirementsCommand(program);
  registerExportContextCommand(program);
  registerCreatePrCommand(program);
  registerDoctorCommand(program);
  registerSettingsCommand(program);
  registerCompletionCommand(program);
  registerProjectCommand(program);
  registerSprintCommand(program);
  registerTicketCommand(program);
  registerTaskCommand(program);
  registerRunsCommand(program);

  await program.parseAsync([...argv]);
};
