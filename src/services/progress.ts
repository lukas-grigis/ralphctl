import { getProgressFilePath } from '@src/utils/paths.ts';
import { appendToFile, readTextFile, FileNotFoundError } from '@src/utils/storage.ts';
import { resolveScopeId } from '@src/services/scope.ts';

export async function logProgress(message: string, scopeId?: string): Promise<void> {
  const id = await resolveScopeId(scopeId);
  const timestamp = new Date().toISOString();
  const entry = `## ${timestamp}\n\n${message}\n\n---\n\n`;
  await appendToFile(getProgressFilePath(id), entry);
}

export async function getProgress(scopeId?: string): Promise<string> {
  const id = await resolveScopeId(scopeId);
  try {
    return await readTextFile(getProgressFilePath(id));
  } catch (err) {
    if (err instanceof FileNotFoundError) {
      return '';
    }
    throw err;
  }
}
