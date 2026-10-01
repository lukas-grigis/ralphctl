import { type Dirent, promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { Result } from '@src/domain/result.ts';
import { NotFoundError } from '@src/domain/value/error/not-found-error.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';

/**
 * Read a JSON file and return its parsed contents (still as `unknown` — caller decodes via the relevant codec).
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
 * Write text content to a file atomically: write to a sibling temp file, **fsync the file's data to disk**, then
 * rename over the target.
 */
let tmpSeq = 0;
const nextTmpSeq = (): number => {
  tmpSeq = (tmpSeq + 1) % Number.MAX_SAFE_INTEGER;
  return tmpSeq;
};

export const writeTextAtomic = async (path: string, content: string): Promise<Result<void, StorageError>> => {
  const dir = dirname(path);
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch (cause) {
    return Result.error(new StorageError({ subCode: 'io', message: `mkdir failed: ${dir}`, path: dir, cause }));
  }
  // pid distinguishes processes; the monotonic counter distinguishes same-millisecond calls within this process.
  const tmp = `${path}.tmp.${String(process.pid)}.${String(Date.now())}.${String(nextTmpSeq())}`;
  try {
    const handle = await fs.open(tmp, 'w');
    try {
      await handle.writeFile(content, 'utf8');
      await handle.sync(); // flush data + metadata to disk before the rename makes it visible
    } finally {
      await handle.close();
    }
    await fs.rename(tmp, path);
    await fsyncDir(dir); // best-effort: persist the rename itself (POSIX only)
    return Result.ok(undefined);
  } catch (cause) {
    await fs.rm(tmp, { force: true }).catch(() => {
      // best-effort cleanup of the temp file
    });
    return Result.error(new StorageError({ subCode: 'io', message: `write failed: ${path}`, path, cause }));
  }
};

/** fsync a directory so a rename into it is durable across a crash. */
const fsyncDir = async (dir: string): Promise<void> => {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(dir, 'r');
    await handle.sync();
  } catch {
    // best-effort — Windows (EISDIR/EPERM/EBADF) and exotic filesystems can't fsync a directory.
  } finally {
    await handle?.close().catch(() => {
      // ignore close failures on the directory handle
    });
  }
};

/**
 * Write a JSON file atomically. Pretty-prints with 2-space indent so on-disk diffs in `git status` are reviewable.
 */
export const writeJsonAtomic = async (path: string, value: unknown): Promise<Result<void, StorageError>> =>
  writeTextAtomic(path, `${JSON.stringify(value, null, 2)}\n`);

/** Delete a file. */
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
 * Recursively delete a directory and its contents. Returns `NotFoundError` when the directory doesn't exist;
 * `StorageError` for other I/O issues.
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

/** Atomically rename a path (file or directory) to a new name on the SAME filesystem. */
export const renamePath = async (from: string, to: string): Promise<Result<void, NotFoundError | StorageError>> => {
  try {
    await fs.rename(from, to);
    return Result.ok(undefined);
  } catch (cause) {
    if (isNodeErrnoCode(cause, 'ENOENT')) {
      return Result.error(new NotFoundError({ entity: 'path', id: from, message: `path not found: ${from}` }));
    }
    return Result.error(
      new StorageError({ subCode: 'io', message: `rename failed: ${from} → ${to}`, path: from, cause })
    );
  }
};

/**
 * List the immediate entries of a directory. A missing directory returns an empty list (not an error) — callers treat
 * "no entries yet" the same as "directory absent."
 */
export const listDir = async (path: string): Promise<Result<readonly string[], StorageError>> => {
  try {
    return Result.ok(await fs.readdir(path));
  } catch (cause) {
    if (isNodeErrnoCode(cause, 'ENOENT') || isNodeErrnoCode(cause, 'ENOTDIR')) return Result.ok([]);
    return Result.error(new StorageError({ subCode: 'io', message: `readdir failed: ${path}`, path, cause }));
  }
};

/** Stat a path and report whether it exists as a directory. */
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
 * Report whether anything (file, directory, symlink) exists at the path. Resolves `false` for `ENOENT` / `ENOTDIR`;
 * other I/O failures surface as `StorageError`.
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

/** Probe whether the current process can write to a path (via `fs.access(W_OK)`). */
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

/** Sum file sizes under `dir`, recursively. */
export const dirSizeBytes = async (dir: string): Promise<number> => {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let total = 0;
  for (const entry of entries) {
    const entryPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      total += await dirSizeBytes(entryPath);
      continue;
    }
    try {
      const stat = await fs.lstat(entryPath);
      if (stat.isFile()) total += stat.size;
    } catch {
      // vanished mid-walk
    }
  }
  return total;
};

export const isNodeErrnoCode = (cause: unknown, code: string): boolean =>
  typeof cause === 'object' && cause !== null && (cause as { code?: unknown }).code === code;
