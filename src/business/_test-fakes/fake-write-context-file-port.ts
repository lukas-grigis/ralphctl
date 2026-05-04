/**
 * `FakeWriteContextFilePort` — non-IO fake of {@link WriteContextFilePort}.
 *
 * Captures every `(path, content)` write so tests can inspect what the
 * `write-task-context` leaf produced without touching the filesystem.
 *
 * `failWith` flips every call to a `Result.error(...)`, used to exercise
 * the chain leaf's hard-failure path.
 */
import type { WriteContextFilePort } from '@src/business/ports/write-context-file-port.ts';
import type { StorageError } from '@src/domain/errors/storage-error.ts';
import { Result } from '@src/domain/result.ts';
import type { AbsolutePath } from '@src/domain/values/absolute-path.ts';

export interface FakeWriteContextFileOptions {
  readonly failWith?: StorageError;
}

export class FakeWriteContextFilePort implements WriteContextFilePort {
  readonly writes: { path: AbsolutePath; content: string }[] = [];

  constructor(private readonly opts: FakeWriteContextFileOptions = {}) {}

  write(path: AbsolutePath, content: string): Promise<Result<void, StorageError>> {
    this.writes.push({ path, content });
    if (this.opts.failWith) return Promise.resolve(Result.error(this.opts.failWith));
    return Promise.resolve(Result.ok());
  }
}
