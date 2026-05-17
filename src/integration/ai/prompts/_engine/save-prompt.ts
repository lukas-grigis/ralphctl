import type { Result } from '@src/domain/result.ts';
import type { Prompt } from '@src/integration/ai/prompts/_engine/prompt-type.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { WriteFile } from '@src/business/io/write-file.ts';

/**
 * Persist a rendered prompt to disk for human review or replay. Delegates to the supplied
 * {@link WriteFile} port; the production adapter uses atomic write-tmp + rename so readers
 * either see the old content or the full new content, never a partial write.
 *
 * The `Prompt` brand guarantees the content has been validated as fully-substituted before it
 * reaches disk; saving a stray `string` is a type error.
 */
export const savePrompt = async (
  writeFile: WriteFile,
  path: AbsolutePath,
  prompt: Prompt
): Promise<Result<void, StorageError>> => writeFile(path, prompt);
