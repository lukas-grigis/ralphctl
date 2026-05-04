/**
 * `FileWriteContextFileAdapter` — `WriteContextFilePort` implementation
 * backed by `node:fs/promises`.
 *
 * Mirrors the same `mkdir -p` + `writeFile` pattern used by
 * {@link FileSystemSignalHandler} so per-task context files land alongside
 * `progress.md` and `evaluations/<task-id>.md` under the same
 * `<sprintDir>/` tree with consistent permissions (0o600 — user-only,
 * matches the project context file conventions).
 *
 * Failures wrap the underlying `NodeJS.ErrnoException` in a
 * `StorageError(subCode: 'io')` carrying the path so callers can route
 * the error through the chain trace cleanly.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { WriteContextFilePort } from '@src/business/ports/write-context-file-port.ts';
import { StorageError } from '@src/domain/errors/storage-error.ts';
import { Result } from '@src/domain/result.ts';
import type { AbsolutePath } from '@src/domain/values/absolute-path.ts';

export class FileWriteContextFileAdapter implements WriteContextFilePort {
  async write(path: AbsolutePath, content: string): Promise<Result<void, StorageError>> {
    try {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content.endsWith('\n') ? content : `${content}\n`, {
        encoding: 'utf-8',
        mode: 0o600,
      });
      return Result.ok();
    } catch (err) {
      return Result.error(
        new StorageError({
          subCode: 'io',
          message: `failed to write task context ${path}: ${err instanceof Error ? err.message : String(err)}`,
          path,
          cause: err,
        })
      );
    }
  }
}
