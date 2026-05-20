import type { Result } from '@src/domain/result.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { DecisionEntry } from '@src/business/sprint/state-projection.ts';

/**
 * Output port for loading `<sprintDir>/decisions.log` into a normalised {@link DecisionEntry}
 * array. The file is the authoritative on-disk record of every `<decision>` signal the
 * harness saw during a sprint — produced by `decisions-log-sink.ts` and consumed by the
 * progress.md snapshot renderer.
 *
 * Tolerant by contract — same shape as {@link LoadChainLog}:
 *  - file missing  → `Result.ok([])`  (a sprint with no decisions yet has no file)
 *  - blank line    → skipped silently
 *  - malformed line → skipped silently (one corrupted line cannot break progress.md)
 *
 * Real IO errors (permission denied, EIO during read) surface as `StorageError` so the caller
 * can decide whether to fall back to an empty list or escalate.
 *
 * @public
 */
export type LoadDecisionsLog = (path: AbsolutePath) => Promise<Result<readonly DecisionEntry[], StorageError>>;
