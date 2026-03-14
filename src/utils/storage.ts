import { access, appendFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Result } from 'typescript-result';
import type { ZodType } from 'zod';
import { StorageError, ValidationError } from '@src/errors.ts';

// Re-export domain errors so existing callers that import from storage.ts keep working.
export { StorageError, ValidationError } from '@src/errors.ts';

export async function ensureDir(dirPath: string): Promise<void> {
  await mkdir(dirPath, { recursive: true });
}

export async function removeDir(dirPath: string): Promise<void> {
  await rm(dirPath, { recursive: true, force: true });
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function listDirs(dirPath: string): Promise<string[]> {
  try {
    const entries = await readdir(dirPath, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

export async function readValidatedJson<Output>(filePath: string, schema: ZodType<Output>) {
  let content: string;
  try {
    content = await readFile(filePath, 'utf-8');
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
      return Result.error(new StorageError(`File not found: ${filePath}`, err instanceof Error ? err : undefined));
    }
    return Result.error(new StorageError(`Failed to read ${filePath}`, err instanceof Error ? err : undefined));
  }

  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch (err) {
    return Result.error(
      new ValidationError(`Invalid JSON in ${filePath}`, filePath, err instanceof Error ? err : undefined)
    );
  }

  const result = schema.safeParse(data);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    return Result.error(new ValidationError(`Validation failed for ${filePath}:\n${issues}`, filePath, result.error));
  }

  return Result.ok(result.data);
}

export async function writeValidatedJson<Output>(filePath: string, data: Output, schema: ZodType<Output>) {
  const result = schema.safeParse(data);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    return Result.error(
      new ValidationError(`Validation failed before writing to ${filePath}:\n${issues}`, filePath, result.error)
    );
  }

  try {
    await ensureDir(dirname(filePath));
    await writeFile(filePath, JSON.stringify(result.data, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 });
  } catch (err) {
    return Result.error(new StorageError(`Failed to write ${filePath}`, err instanceof Error ? err : undefined));
  }

  return Result.ok(undefined);
}

export async function appendToFile(filePath: string, content: string) {
  try {
    await ensureDir(dirname(filePath));
    await appendFile(filePath, content, { encoding: 'utf-8', mode: 0o600 });
    return Result.ok(undefined);
  } catch (err) {
    return Result.error(new StorageError(`Failed to append to ${filePath}`, err instanceof Error ? err : undefined));
  }
}

export async function readTextFile(filePath: string) {
  try {
    const content = await readFile(filePath, 'utf-8');
    return Result.ok(content);
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
      return Result.error(new StorageError(`File not found: ${filePath}`, err instanceof Error ? err : undefined));
    }
    return Result.error(new StorageError(`Failed to read ${filePath}`, err instanceof Error ? err : undefined));
  }
}
