import type { Command } from 'commander';
import { generateCompletion, type Shell } from '@src/application/ui/cli/completion.ts';

const SUPPORTED: readonly Shell[] = ['bash', 'zsh'];

/**
 * Register the `completion <shell>` CLI command.
 *
 *   ralphctl completion bash >> ~/.bashrc
 *   ralphctl completion zsh  >> ~/.zshrc
 *
 * Prints the completion script to stdout. The user redirects to their shell config — keeps
 * this command side-effect-free and avoids touching arbitrary files in the user's home.
 */
export const registerCompletionCommand = (program: Command): void => {
  program
    .command('completion <shell>')
    .description(`print a shell-completion script (supported: ${SUPPORTED.join(', ')})`)
    .action((shell: string) => {
      if (!(SUPPORTED as readonly string[]).includes(shell)) {
        process.stderr.write(`error: unsupported shell '${shell}' — supported: ${SUPPORTED.join(', ')}\n`);
        process.exit(1);
        return;
      }
      process.stdout.write(generateCompletion(shell as Shell));
    });
};
