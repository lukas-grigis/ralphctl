import type { Result } from '@src/domain/result.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { StorageError } from '@src/domain/value/error/storage-error.ts';

/**
 * Output port for writing a file to disk by absolute path. The adapter under
 * `integration/io/write-file-atomic.ts` wraps `writeTextAtomic` so writes are crash-safe
 * (write-to-temp + rename). Tests pass a fake matching this function shape that records writes
 * in memory.
 *
 * Lives in `business/io/` — the generic "given a path and a string, drop it on disk" capability
 * that flows like readiness, plan, refine, ideate, and export-* depend on. Concrete file
 * persistence (codecs, encoding, storage layout) stays in `integration/persistence/`.
 *
 * Implementations should be atomic (no half-written file visible to a concurrent reader) and
 * create parent directories as needed.
 */
export type WriteFile = (path: AbsolutePath, content: string) => Promise<Result<void, StorageError>>;
