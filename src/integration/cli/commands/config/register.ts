import type { Command } from 'commander';
import { configSetCommand, configShowCommand } from '@src/integration/cli/commands/config/config.ts';

export function registerConfigCommands(program: Command): void {
  const config = program.command('config').description('Manage configuration');

  config.addHelpText(
    'after',
    `
Examples:
  $ ralphctl config show                    # Show current configuration
  $ ralphctl config set provider claude     # Use Claude Code
  $ ralphctl config set provider copilot    # Use GitHub Copilot
  $ ralphctl config set editor "subl -w"    # Use Sublime Text for multiline input
  $ ralphctl config set editor "code --wait"  # Use VS Code for multiline input
  $ ralphctl config set editor vim          # Use Vim for multiline input
`
  );

  config
    .command('show')
    .description('Show current configuration')
    .action(async () => {
      await configShowCommand();
    });

  config
    .command('set <key> <value>')
    .description('Set a configuration value')
    .action(async (key: string, value: string) => {
      await configSetCommand([key, value]);
    });
}
