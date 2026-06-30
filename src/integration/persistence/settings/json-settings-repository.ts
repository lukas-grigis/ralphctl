import { join } from 'node:path';
import { Result } from '@src/domain/result.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { ParseError } from '@src/domain/value/error/parse-error.ts';
import type { StorageError } from '@src/domain/value/error/storage-error.ts';
import { pathExists, readJson, writeJsonAtomic } from '@src/integration/io/fs.ts';
import type { Settings } from '@src/domain/entity/settings.ts';
import { CURRENT_SCHEMA_VERSION, SettingsSchema } from '@src/domain/entity/settings.ts';
import { DEFAULT_SETTINGS } from '@src/business/settings/defaults.ts';
import { applyMigrations, readSchemaVersion } from '@src/business/settings/migrations.ts';
import type { SettingsRepository } from '@src/domain/repository/settings/settings-repository.ts';

const SETTINGS_FILE = 'settings.json';
const SCHEMA_MISMATCH = 'schema-mismatch';

/**
 * Re-run hint attached to every read-path `ParseError` — the CLI surfaces `.hint` in parentheses
 * after the message (see `application/ui/cli/commands/settings.ts`). A corrupt / un-migratable
 * `settings.json` blocks the read-modify-write `settings set` path too (it loads first), so the
 * actionable repair is to fix or remove the on-disk file and let the next launch fall back to
 * defaults — not to re-run a mutating command.
 */
const REPAIR_HINT = 'fix or delete settings.json and re-run; a missing file falls back to defaults';

export interface JsonSettingsRepositoryDeps {
  /** Directory where the JSON file lives. Production: `<appRoot>/config/`. Tests: a tmp dir. */
  readonly configRoot: AbsolutePath;
}

/**
 * File-backed `SettingsRepository`. Reads + validates `<configRoot>/settings.json`. A missing
 * file resolves to {@link DEFAULT_SETTINGS} so fresh installs work without writing first; a
 * malformed file surfaces as `ParseError` so misconfiguration is loud rather than silently
 * coerced.
 *
 * Writes go through {@link writeJsonAtomic} for the rename-based atomicity that protects
 * against half-written files when the process is interrupted mid-save.
 */
export const createJsonSettingsRepository = (deps: JsonSettingsRepositoryDeps): SettingsRepository => {
  const path = join(String(deps.configRoot), SETTINGS_FILE);

  return {
    path,

    async exists() {
      return pathExists(path);
    },

    async load() {
      const json = await readJson(path);
      if (!json.ok) {
        if (json.error.code === 'not-found') {
          return Result.ok(DEFAULT_SETTINGS) as Result<Settings, ParseError | StorageError>;
        }
        return Result.error(json.error);
      }

      // Reject files from a future ralphctl — we can't downgrade. The user must upgrade the
      // CLI; we'd rather surface a clear error than try to coerce a shape we don't understand.
      const sourceVersion = readSchemaVersion(json.value);
      if (sourceVersion > CURRENT_SCHEMA_VERSION) {
        return Result.error(
          new ParseError({
            subCode: SCHEMA_MISMATCH,
            message: `settings at ${path} are from a newer ralphctl (schemaVersion=${String(sourceVersion)}, expected ${String(CURRENT_SCHEMA_VERSION)}). Upgrade ralphctl.`,
            hint: 'upgrade ralphctl, or fix/delete settings.json to start from defaults',
          })
        );
      }

      // Walk the migration chain. Each step is `unknown → unknown`; the final zod parse
      // catches any migration that produced an off-schema shape.
      const outcome = applyMigrations(json.value);
      if (outcome.toVersion < CURRENT_SCHEMA_VERSION) {
        return Result.error(
          new ParseError({
            subCode: SCHEMA_MISMATCH,
            message: `settings at ${path} cannot be migrated: no chain from v${String(outcome.fromVersion)} to v${String(CURRENT_SCHEMA_VERSION)} (stopped at v${String(outcome.toVersion)}).`,
            hint: REPAIR_HINT,
          })
        );
      }

      const parsed = SettingsSchema.safeParse(outcome.value);
      if (!parsed.success) {
        return Result.error(
          new ParseError({
            subCode: SCHEMA_MISMATCH,
            message: `settings at ${path} are invalid: ${parsed.error.message}`,
            cause: parsed.error,
            hint: REPAIR_HINT,
          })
        );
      }

      // Persist the upgraded file so subsequent loads don't re-run the chain. Disk-write
      // failures here are non-fatal: the next launch will repeat the migration.
      if (outcome.applied.length > 0) {
        await writeJsonAtomic(path, parsed.data);
      }

      return Result.ok(parsed.data) as Result<Settings, ParseError | StorageError>;
    },

    async save(settings) {
      const parsed = SettingsSchema.safeParse(settings);
      if (!parsed.success) {
        return Result.error(
          new ParseError({
            subCode: SCHEMA_MISMATCH,
            message: `settings validation failed before save: ${parsed.error.message}`,
            cause: parsed.error,
          })
        );
      }
      return writeJsonAtomic(path, parsed.data);
    },
  };
};
