import { getProgress } from '@src/integration/persistence/progress.ts';
import { printHeader, showEmpty } from '@src/integration/ui/theme/ui.ts';

export async function progressShowCommand(): Promise<void> {
  const content = await getProgress();

  if (!content.trim()) {
    showEmpty('progress entries', 'Log with: ralphctl progress log');
    return;
  }

  printHeader('Progress Log');
  console.log(content);
}
