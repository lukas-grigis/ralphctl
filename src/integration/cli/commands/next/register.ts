import type { Command } from 'commander';
import { nextCommand } from '@src/integration/cli/commands/next/next.ts';

interface NextCliOptions {
  porcelain?: boolean;
  json?: boolean;
}

export function registerNextCommands(program: Command): void {
  program
    .command('next')
    .description('Suggest the next workflow action for the current sprint')
    .option('--porcelain', 'Print only the suggested command (for shell/tmux integration)')
    .option('--json', 'Emit a machine-readable JSON payload')
    .action(async (options: NextCliOptions) => {
      await nextCommand(options);
    });
}
