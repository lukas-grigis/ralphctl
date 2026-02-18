import type { Command } from 'commander';
import { configSetCommand, configShowCommand } from '@src/commands/config/config.ts';

export function registerConfigCommands(program: Command): void {
  const config = program.command('config').description('Manage configuration');

  config.addHelpText(
    'after',
    `
Examples:
  $ ralphctl config show                    # Show current configuration
  $ ralphctl config set provider claude     # Use Claude Code
  $ ralphctl config set provider copilot    # Use GitHub Copilot
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
