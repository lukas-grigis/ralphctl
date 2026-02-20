import { select } from '@inquirer/prompts';
import { getEditor, setEditor } from '@src/store/config.ts';
import { emoji } from '@src/theme/ui.ts';

/**
 * Resolve the configured editor command.
 * Reads from config; if not set, prompts the user to choose and saves the selection.
 */
export async function resolveEditor(): Promise<string> {
  const stored = await getEditor();
  if (stored) return stored;

  const choice = await select({
    message: `${emoji.donut} Which editor should open for multiline input?`,
    choices: [
      { name: 'Sublime Text', value: 'subl -w' },
      { name: 'VS Code', value: 'code --wait' },
      { name: 'Vim', value: 'vim' },
      { name: 'Nano', value: 'nano' },
      { name: 'Use $EDITOR env var', value: '__env__' },
    ],
  });

  if (choice === '__env__') {
    const envEditor = process.env['VISUAL'] ?? process.env['EDITOR'];
    if (!envEditor) {
      // Fallback: no env var set, default to vim
      await setEditor('vim');
      return 'vim';
    }
    await setEditor(envEditor);
    return envEditor;
  }

  await setEditor(choice);
  return choice;
}
