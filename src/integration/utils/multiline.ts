import * as readline from 'node:readline';
import { muted } from '@src/integration/ui/theme/theme.ts';
import { icons } from '@src/integration/ui/theme/ui.ts';

export interface MultilineInputOptions {
  /** Message/prompt to display */
  message: string;
  /** Default value (will be shown as initial lines) */
  default?: string;
  /** Hint text shown after the message */
  hint?: string;
}

/**
 * Prompt for multiline input with paste support.
 * Ctrl+D to finish (standard Unix EOF).
 * Supports pasting multiline text including blank lines.
 *
 * @returns Joined lines as a single string
 */
export async function multilineInput(options: MultilineInputOptions): Promise<string> {
  const { message, default: defaultValue, hint = 'Ctrl+D to finish' } = options;

  // Show the prompt with hint
  console.log(`${icons.edit} ${message} ${muted(`(${hint})`)}`);

  // If there's a default value, show it
  if (defaultValue) {
    console.log(muted('  Default:'));
    for (const line of defaultValue.split('\n')) {
      console.log(muted(`    ${line}`));
    }
    console.log('');
  }

  const lines: string[] = [];

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: process.stdin.isTTY,
  });

  return new Promise<string>((resolve) => {
    rl.on('line', (line) => {
      lines.push(line);
    });

    rl.on('close', () => {
      // Print newline after Ctrl+D for clean formatting
      console.log('');

      // Trim trailing empty lines
      while (lines.length > 0 && lines.at(-1)?.trim() === '') {
        lines.pop();
      }

      resolve(lines.join('\n'));
    });
  });
}
