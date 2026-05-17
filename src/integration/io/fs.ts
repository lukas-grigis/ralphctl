import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import { Result } from '@src/domain/result.ts';
import { NotFoundError } from '@src/domain/value/error/not-found-error.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';

/**
 * Read a JSON file and return its parsed contents (still as `unknown` — caller decodes via the
 * relevant codec). Distinguishes the three failure shapes callers care about:
 *  - file missing       → `NotFoundError` (a normal outcome for `findById`)
 *  - file unreadable    → `StorageError` (subCode `'io'`)
 *  - file not valid JSON → `StorageError` (subCode `'parse'`)
 *
 * `ENOTDIR` (a path component along the way isn't a directory) is reported as `NotFoundError`,
 * not `StorageError`: callers that iterate `listDir(<root>/sprints)` looking for
 * `<root>/sprints/<id>/sprint.json` legitimately hit this when a stray FILE (`.DS_Store`,
 * `.gitkeep`, …) sits next to the per-id subfolders. Treating it as "file not there" lets the
 * existing skip-on-NotFound loops handle the case without special casing.
 */
export const readJson = async (path: string): Promise<Result<unknown, NotFoundError | StorageError>> => {
  let content: string;
  try {
    content = await fs.readFile(path, 'utf8');
  } catch (cause) {
    if (isNodeErrnoCode(cause, 'ENOENT') || isNodeErrnoCode(cause, 'ENOTDIR')) {
      return Result.error(new NotFoundError({ entity: 'file', id: path, message: `file not found: ${path}` }));
    }
    return Result.error(new StorageError({ subCode: 'io', message: `read failed: ${path}`, path, cause }));
  }
  try {
    return Result.ok(JSON.parse(content));
  } catch (cause) {
    return Result.error(new StorageError({ subCode: 'parse', message: `invalid JSON: ${path}`, path, cause }));
  }
};

/**
 * Write text content to a file atomically: write to a sibling temp file, fsync, then rename
 * over the target. The rename is atomic on POSIX filesystems, so readers either see the old
 * content or the full new content — never a half-written file. Creates parent directories as
 * needed.
 */
export const writeTextAtomic = async (path: string, content: string): Promise<Result<void, StorageError>> => {
  const dir = dirname(path);
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch (cause) {
    return Result.error(new StorageError({ subCode: 'io', message: `mkdir failed: ${dir}`, path: dir, cause }));
  }
  const tmp = `${path}.tmp.${String(process.pid)}.${String(Date.now())}`;
  try {
    await fs.writeFile(tmp, content, 'utf8');
    await fs.rename(tmp, path);
    return Result.ok(undefined);
  } catch (cause) {
    await fs.rm(tmp, { force: true }).catch(() => {
      // best-effort cleanup of the temp file
    });
    return Result.error(new StorageError({ subCode: 'io', message: `write failed: ${path}`, path, cause }));
  }
};

/**
 * Write a JSON file atomically. Pretty-prints with 2-space indent so on-disk diffs in
 * `git status` are reviewable. Delegates to `writeTextAtomic` for the rename-based atomicity.
 */
export const writeJsonAtomic = async (path: string, value: unknown): Promise<Result<void, StorageError>> =>
  writeTextAtomic(path, `${JSON.stringify(value, null, 2)}\n`);

/**
 * Delete a file. Returns `NotFoundError` if the file did not exist (callers can decide whether
 * "remove if exists" is acceptable via the error code) or `StorageError` for other I/O issues.
 */
export const removeFile = async (path: string): Promise<Result<void, NotFoundError | StorageError>> => {
  try {
    await fs.unlink(path);
    return Result.ok(undefined);
  } catch (cause) {
    if (isNodeErrnoCode(cause, 'ENOENT')) {
      return Result.error(new NotFoundError({ entity: 'file', id: path, message: `file not found: ${path}` }));
    }
    return Result.error(new StorageError({ subCode: 'io', message: `unlink failed: ${path}`, path, cause }));
  }
};

/**
 * Recursively delete a directory and its contents. Returns `NotFoundError` when the directory
 * doesn't exist; `StorageError` for other I/O issues.
 */
export const removeDir = async (path: string): Promise<Result<void, NotFoundError | StorageError>> => {
  try {
    await fs.rm(path, { recursive: true });
    return Result.ok(undefined);
  } catch (cause) {
    if (isNodeErrnoCode(cause, 'ENOENT')) {
      return Result.error(new NotFoundError({ entity: 'dir', id: path, message: `dir not found: ${path}` }));
    }
    return Result.error(new StorageError({ subCode: 'io', message: `rm -rf failed: ${path}`, path, cause }));
  }
};

/**
 * List the immediate entries of a directory. A missing directory returns an empty list (not an
 * error) — callers treat "no entries yet" the same as "directory absent."
 */
export const listDir = async (path: string): Promise<Result<readonly string[], StorageError>> => {
  try {
    return Result.ok(await fs.readdir(path));
  } catch (cause) {
    if (isNodeErrnoCode(cause, 'ENOENT') || isNodeErrnoCode(cause, 'ENOTDIR')) return Result.ok([]);
    return Result.error(new StorageError({ subCode: 'io', message: `readdir failed: ${path}`, path, cause }));
  }
};

/**
 * Stat a path and report whether it exists as a directory. Returns `false` (not an error) when
 * the path is missing or is a non-directory entry — callers that distinguish those two need to
 * use `fs.stat` directly. Other I/O failures (permission denied, etc.) surface as `StorageError`.
 */
export const pathIsDirectory = async (path: string): Promise<Result<boolean, StorageError>> => {
  try {
    const stat = await fs.stat(path);
    return Result.ok(stat.isDirectory());
  } catch (cause) {
    if (isNodeErrnoCode(cause, 'ENOENT') || isNodeErrnoCode(cause, 'ENOTDIR')) return Result.ok(false);
    return Result.error(new StorageError({ subCode: 'io', message: `stat failed: ${path}`, path, cause }));
  }
};

/**
 * Report whether anything (file, directory, symlink) exists at the path. Resolves `false` for
 * `ENOENT` / `ENOTDIR`; other I/O failures surface as `StorageError`. Used by callers that
 * want a yes/no without caring about the entry kind (e.g. first-run detection).
 */
export const pathExists = async (path: string): Promise<Result<boolean, StorageError>> => {
  try {
    await fs.stat(path);
    return Result.ok(true);
  } catch (cause) {
    if (isNodeErrnoCode(cause, 'ENOENT') || isNodeErrnoCode(cause, 'ENOTDIR')) return Result.ok(false);
    return Result.error(new StorageError({ subCode: 'io', message: `stat failed: ${path}`, path, cause }));
  }
};

/**
 * Probe whether the current process can write to a path (via `fs.access(W_OK)`). Resolves
 * `false` for `EACCES` / `EROFS` / missing-path; other I/O failures surface as `StorageError`.
 * Doctor uses this to flag a read-only home before flows hit it at write time.
 */
export const pathIsWritable = async (path: string): Promise<Result<boolean, StorageError>> => {
  try {
    await fs.access(path, fs.constants.W_OK);
    return Result.ok(true);
  } catch (cause) {
    if (
      isNodeErrnoCode(cause, 'EACCES') ||
      isNodeErrnoCode(cause, 'EROFS') ||
      isNodeErrnoCode(cause, 'ENOENT') ||
      isNodeErrnoCode(cause, 'ENOTDIR')
    ) {
      return Result.ok(false);
    }
    return Result.error(new StorageError({ subCode: 'io', message: `access failed: ${path}`, path, cause }));
  }
};

export const isNodeErrnoCode = (cause: unknown, code: string): boolean =>
  typeof cause === 'object' && cause !== null && (cause as { code?: unknown }).code === code;
