import { info, muted, warning } from '@src/utils/colors.ts';
import { getProgress } from '@src/services/progress.ts';

export async function progressShowCommand(): Promise<void> {
  const content = await getProgress();

  if (!content.trim()) {
    console.log(warning('\nNo progress logged yet.'));
    console.log(muted('Log progress with: ralphctl progress log <message>\n'));
    return;
  }

  console.log(info('\n=== Progress Log ===\n'));
  console.log(content);
}
