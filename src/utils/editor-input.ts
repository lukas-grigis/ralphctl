import { editor } from '@inquirer/prompts';
import { resolveEditor } from '@src/utils/editor.ts';

export interface EditorInputOptions {
  /** Message/prompt to display */
  message: string;
  /** Default value (pre-populated in the editor) */
  default?: string;
}

/**
 * Open the user's configured editor for multiline text input.
 * Uses @inquirer/editor under the hood, with the editor resolved from config.
 *
 * Falls back to readline-based multilineInput when stdin is not a TTY.
 */
export async function editorInput(options: EditorInputOptions): Promise<string> {
  // Non-TTY fallback: delegate to readline-based multilineInput
  if (!process.stdin.isTTY) {
    const { multilineInput } = await import('@src/utils/multiline.ts');
    return multilineInput({ message: options.message, default: options.default });
  }

  const editorCmd = await resolveEditor();

  // Temporarily set VISUAL so @inquirer/editor uses our configured editor
  const prevVisual = process.env['VISUAL'];
  process.env['VISUAL'] = editorCmd;

  try {
    const result = await editor({
      message: options.message,
      default: options.default,
      postfix: '.md',
    });
    return result.trim();
  } finally {
    if (prevVisual === undefined) delete process.env['VISUAL'];
    else process.env['VISUAL'] = prevVisual;
  }
}
