import { Result } from 'typescript-result';
import { getPrompt } from '@src/integration/bootstrap.ts';
import { IOError } from '@src/domain/errors.ts';

interface EditorInputOptions {
  /** Message/prompt to display */
  message: string;
  /** Default value (pre-populated in the editor) */
  default?: string;
}

/**
 * Open the user's configured editor for multiline text input.
 * Delegates to the PromptPort editor, which handles TTY fallback, the
 * configured editor command, and cancellation semantics.
 *
 * Returns Result.error(IOError) when the editor is cancelled or fails,
 * matching the existing error path for callers.
 */
export async function editorInput(options: EditorInputOptions) {
  try {
    const result = await getPrompt().editor({
      message: options.message,
      default: options.default,
      kind: 'markdown',
    });
    if (result === null) {
      return Result.error(new IOError('Editor cancelled'));
    }
    return Result.ok(result);
  } catch (err) {
    return Result.error(
      new IOError(
        `Editor failed: ${err instanceof Error ? err.message : String(err)}`,
        err instanceof Error ? err : undefined
      )
    );
  }
}
