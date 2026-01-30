import { editor } from '@inquirer/prompts';
import { success, error } from '@src/utils/colors.ts';
import { logProgress } from '@src/services/progress.ts';

export async function progressLogCommand(args: string[]): Promise<void> {
  let message = args.join(' ').trim();

  // If no message provided, open editor
  if (!message) {
    message = await editor({
      message: 'Progress message:',
      default: '',
      waitForUserInput: false,
    });
    message = message.trim();
  }

  if (!message) {
    console.log(error('\nNo message provided.\n'));
    return;
  }

  await logProgress(message);
  console.log(success('\nProgress logged successfully.\n'));
}
