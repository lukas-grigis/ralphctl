import type { Result } from '@src/domain/result.ts';
import type { ParseError } from '@src/domain/value/error/parse-error.ts';
import type { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { Settings } from '@src/domain/entity/settings.ts';

/**
 * Persistence port for {@link Settings} — the singleton "user preferences" record. Unlike
 * project / sprint repositories there is no `findById`; the singleton is loaded by `load` and
 * overwritten wholesale by `save`. Patches happen at the use-case level (read → derive →
 * save) so atomic-write semantics still apply.
 *
 * `load` returns `DEFAULT_SETTINGS` when no file exists yet — a fresh install works without
 * writing anything first. A malformed file surfaces as `ParseError(schema-mismatch)` so
 * misconfiguration is loud.
 */
export interface SettingsRepository {
  /**
   * Absolute path to the underlying settings file. Exposed for diagnostics — the doctor
   * probe surfaces this so the operator can see exactly where settings live (or would live)
   * regardless of whether the file has been written yet.
   */
  readonly path: string;
  /**
   * Whether a persisted settings record exists. Drives first-run detection — when `false`,
   * `load` will resolve to `DEFAULT_SETTINGS` (the user has not yet configured anything).
   */
  exists(): Promise<Result<boolean, StorageError>>;
  load(): Promise<Result<Settings, ParseError | StorageError>>;
  save(settings: Settings): Promise<Result<void, ParseError | StorageError>>;
}
