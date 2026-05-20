import type { Result } from '@src/domain/result.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { ChainLogEntry } from '@src/business/sprint/state-projection.ts';

/**
 * Output port for loading the `<sprintDir>/chain.log` NDJSON file into a normalised
 * {@link ChainLogEntry} array.
 *
 * Tolerant by contract:
 *  - file missing  → `Result.ok([])`  (a sprint with no run yet has no log; that's not an error)
 *  - blank / boundary lines → skipped silently
 *  - malformed JSON line    → skipped silently (caller may surface a count via the logger but
 *                              the projection MUST be renderable from a partial log; a corrupt
 *                              line cannot break progress.md)
 *
 * Real IO errors (permission denied, EIO during read) surface as `StorageError` — the snapshot
 * writer's caller decides whether to fall back to an empty list or escalate.
 *
 * @public
 */
export type LoadChainLog = (path: AbsolutePath) => Promise<Result<readonly ChainLogEntry[], StorageError>>;
