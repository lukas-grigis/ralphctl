import { editor } from '@inquirer/prompts';
import { Result } from 'typescript-result';
import { IOError } from '@src/errors.ts';
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
export async function editorInput(options: EditorInputOptions) {
  // Non-TTY fallback: delegate to readline-based multilineInput
  if (!process.stdin.isTTY) {
    const { multilineInput } = await import('@src/utils/multiline.ts');
    const value = await multilineInput({ message: options.message, default: options.default });
    return Result.ok(value);
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
    return Result.ok(result.trim());
  } catch (err) {
    return Result.error(
      new IOError(
        `Editor failed: ${err instanceof Error ? err.message : String(err)}`,
        err instanceof Error ? err : undefined
      )
    );
  } finally {
    if (prevVisual === undefined) delete process.env['VISUAL'];
    else process.env['VISUAL'] = prevVisual;
  }
}
