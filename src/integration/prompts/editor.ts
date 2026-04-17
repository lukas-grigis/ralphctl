import { getPrompt } from '@src/application/bootstrap.ts';
import { getEditor, setEditor } from '@src/integration/persistence/config.ts';
import { emoji } from '@src/integration/ui/theme/ui.ts';

/**
 * Resolve the configured editor command.
 * Reads from config; if not set, prompts the user to choose and saves the selection.
 */
export async function resolveEditor(): Promise<string> {
  const stored = await getEditor();
  if (stored) return stored;

  const choice = await getPrompt().select({
    message: `${emoji.donut} Which editor should open for multiline input?`,
    choices: [
      { label: 'Sublime Text', value: 'subl -w' },
      { label: 'VS Code', value: 'code --wait' },
      { label: 'Vim', value: 'vim' },
      { label: 'Nano', value: 'nano' },
      { label: 'Use $EDITOR env var', value: '__env__' },
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
