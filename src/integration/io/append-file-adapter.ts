import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import { Result } from '@src/domain/result.ts';
import type { AppendFile } from '@src/business/io/append-file.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';

/**
 * `AppendFile` adapter that uses `fs.appendFile`. Creates parent directories on first write
 * (idempotent — repeated calls in the same process re-use the cached `dirEnsured` flag) and
 * lets `fs.appendFile`'s implicit create-if-missing handle the file itself.
 *
 * Suitable for the per-sprint append-only journal (`progress.md`) and the opt-in
 * `events.ndjson` debug trace. The on-disk file format is determined by the caller — this
 * adapter is byte-faithful.
 *
 * Not atomic across processes — relies on the per-sprint cross-process advisory lock that
 * already serialises every implement-style run against the same sprint. Within one process,
 * `fs.appendFile` is sequential per call.
 */
export const createAppendFile = (): AppendFile => {
  // Cache directories already ensured for the lifetime of this process. A successful mkdir
  // (recursive) once means the directory exists; subsequent appends to the same file skip
  // the mkdir round-trip. Cache miss → re-create, so an external `rm -rf` is still healed.
  const dirEnsured = new Set<string>();
  return async (path, text) => {
    const dir = dirname(String(path));
    if (!dirEnsured.has(dir)) {
      try {
        await fs.mkdir(dir, { recursive: true });
        dirEnsured.add(dir);
      } catch (cause) {
        return Result.error(new StorageError({ subCode: 'io', message: `mkdir failed: ${dir}`, path: dir, cause }));
      }
    }
    const tryAppend = async (): Promise<Result<void, StorageError>> => {
      try {
        await fs.appendFile(String(path), text, 'utf8');
        return Result.ok(undefined);
      } catch (cause) {
        return Result.error(
          new StorageError({ subCode: 'io', message: `append failed: ${String(path)}`, path: String(path), cause })
        );
      }
    };
    const first = await tryAppend();
    if (first.ok) return first;
    // If the parent vanished between mkdir and append (tmpfs cleanup, external `rm -rf`),
    // heal the dirEnsured cache and retry once. Repeated failures pass through.
    dirEnsured.delete(dir);
    try {
      await fs.mkdir(dir, { recursive: true });
      dirEnsured.add(dir);
    } catch {
      return first;
    }
    return tryAppend();
  };
};
