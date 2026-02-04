import { input } from '@inquirer/prompts';
import { muted } from '@src/theme/index.ts';
import { icons } from '@src/theme/ui.ts';

export interface MultilineInputOptions {
  /** Message/prompt to display */
  message: string;
  /** Default value (will be shown as initial lines) */
  default?: string;
  /** Hint text shown after the message */
  hint?: string;
}

/**
 * Prompt for multiline input, line by line.
 * User enters empty line to finish.
 *
 * @returns Joined lines as a single string (trimmed)
 */
export async function multilineInput(options: MultilineInputOptions): Promise<string> {
  const { message, default: defaultValue, hint = 'empty line to finish' } = options;

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
  let lineNum = 1;

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- intentional infinite loop
  while (true) {
    const line = await input({
      message: muted(`  ${String(lineNum).padStart(2, ' ')}:`),
    });

    if (line.trim() === '') {
      break;
    }

    lines.push(line);
    lineNum++;
  }

  return lines.join('\n');
}
