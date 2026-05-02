/**
 * `ConfigStorePort` — application-layer port for persisting and retrieving
 * the global ralphctl `Config`. Lives outside `business/ports/` because
 * config is an application concern, not a business one.
 *
 * Behaviour contract:
 *  - `load()` always returns a fully populated `Config`. A missing file
 *    yields {@link CONFIG_DEFAULTS}, not a `NotFoundError`.
 *  - Parse / schema mismatch surface as `StorageError` so the caller can
 *    decide whether to abort or fall back.
 *  - `save(config)` validates first; an invalid object becomes
 *    `Result.error(StorageError({ subCode: 'schema-mismatch' }))`.
 */
import type { StorageError } from '@src/domain/errors/storage-error.ts';
import type { Result } from '@src/domain/result.ts';
import type { Config } from './config.ts';

export interface ConfigStorePort {
  /** Load the persisted config; falls back to defaults on a fresh install. */
  load(): Promise<Result<Config, StorageError>>;
  /** Persist a complete `Config`. Validates before writing. */
  save(config: Config): Promise<Result<void, StorageError>>;
}
