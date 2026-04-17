import type { Command } from 'commander';
import { showSuccess } from '@src/integration/ui/theme/ui.ts';

export function registerCompletionCommands(program: Command): void {
  const completion = program.command('completion').description('Manage shell tab-completion');

  completion.addHelpText(
    'after',
    `
Examples:
  $ ralphctl completion install       # Enable tab-completion for your shell
  $ ralphctl completion uninstall     # Remove tab-completion
`
  );

  completion
    .command('install')
    .description('Install shell tab-completion (bash, zsh, fish)')
    .action(async () => {
      const tabtab = (await import('tabtab')).default;
      await tabtab.install({ name: 'ralphctl', completer: 'ralphctl' });
      showSuccess('Shell completion installed. Restart your shell or source your profile to activate.');
    });

  completion
    .command('uninstall')
    .description('Remove shell tab-completion')
    .action(async () => {
      const tabtab = (await import('tabtab')).default;
      await tabtab.uninstall({ name: 'ralphctl' });
      showSuccess('Shell completion removed.');
    });
}
