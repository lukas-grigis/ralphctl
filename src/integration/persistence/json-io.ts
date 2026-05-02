import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ZodType } from 'zod';

import { StorageError } from '@src/domain/errors/storage-error.ts';
import { Result } from '@src/domain/result.ts';
import type { AbsolutePath } from '@src/domain/values/absolute-path.ts';

/**
 * Read a JSON file and validate the parsed value against a Zod schema.
 *
 * Error mapping:
 *  - `ENOENT` → `StorageError({ subCode: 'io' })` (missing file is still a
 *    storage error from this layer's POV; callers that treat missing as
 *    "empty" — e.g. project list, task list — inspect `subCode` + `cause`).
 *  - `JSON.parse` failure → `StorageError({ subCode: 'parse' })`.
 *  - Schema mismatch → `StorageError({ subCode: 'schema-mismatch' })`.
 *  - Anything else from `readFile` → `StorageError({ subCode: 'io' })`.
 */
export async function readJsonFile<T>(path: AbsolutePath, schema: ZodType<T>): Promise<Result<T, StorageError>> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (err) {
    return Result.error(
      new StorageError({
        subCode: 'io',
        message:
          errnoCode(err) === 'ENOENT' ? `file not found: ${path}` : `failed to read ${path}: ${stringifyError(err)}`,
        path,
        cause: err,
      })
    );
  }

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    return Result.error(
      new StorageError({
        subCode: 'parse',
        message: `invalid JSON in ${path}: ${stringifyError(err)}`,
        path,
        cause: err,
      })
    );
  }

  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    return Result.error(
      new StorageError({
        subCode: 'schema-mismatch',
        message: `schema validation failed for ${path}:\n${issues}`,
        path,
        cause: parsed.error,
      })
    );
  }

  return Result.ok(parsed.data) as Result<T, StorageError>;
}

/**
 * Validate a value with the given schema, then atomically write it to disk
 * by writing to a temp sibling and renaming. Atomicity matters because a
 * crash mid-write must leave the prior file intact (resumability).
 *
 *  - Schema rejection → `StorageError({ subCode: 'schema-mismatch' })`.
 *  - Filesystem failure → `StorageError({ subCode: 'io' })`.
 */
export async function writeJsonFile<T>(
  path: AbsolutePath,
  value: T,
  schema: ZodType<T>
): Promise<Result<void, StorageError>> {
  const validated = schema.safeParse(value);
  if (!validated.success) {
    const issues = validated.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    return Result.error(
      new StorageError({
        subCode: 'schema-mismatch',
        message: `schema validation failed before writing ${path}:\n${issues}`,
        path,
        cause: validated.error,
      })
    );
  }

  const dir = dirname(path);
  // The tmp suffix uses pid + timestamp + a random tail to avoid collisions
  // when two processes write the same file concurrently — the file lock is
  // the higher-level guard, but the tmp name is independent regardless.
  const tmp = join(dir, `.${pathBasename(path)}.${String(process.pid)}.${String(Date.now())}.${randomTail()}.tmp`);
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(tmp, JSON.stringify(validated.data, null, 2) + '\n', {
      encoding: 'utf-8',
      mode: 0o600,
    });
    await rename(tmp, path);
    return Result.ok();
  } catch (err) {
    return Result.error(
      new StorageError({
        subCode: 'io',
        message: `failed to write ${path}: ${stringifyError(err)}`,
        path,
        cause: err,
      })
    );
  }
}

function pathBasename(p: string): string {
  const idx = p.lastIndexOf('/');
  return idx === -1 ? p : p.slice(idx + 1);
}

function errnoCode(err: unknown): string | undefined {
  if (err instanceof Error && 'code' in err) {
    const c = (err as { code?: unknown }).code;
    if (typeof c === 'string') return c;
  }
  return undefined;
}

function stringifyError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function randomTail(): string {
  return Math.random().toString(36).slice(2, 10);
}
