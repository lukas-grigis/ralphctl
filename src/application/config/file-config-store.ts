/**
 * `FileConfigStore` — JSON-backed implementation of {@link ConfigStorePort}.
 *
 * Storage location: `<storage.configDir>/config.json` (exactly the path
 * `StoragePaths.configFile` resolves to).
 *
 * Read semantics:
 *  - File missing (`ENOENT`) → return {@link CONFIG_DEFAULTS}. Fresh
 *    installs must not surface a "config not found" error.
 *  - File present but unreadable / unparseable / schema-invalid → return
 *    `StorageError`. The caller decides whether to abort or rewrite.
 *
 * Write semantics:
 *  - `save()` validates the input against the local Zod schema, then
 *    delegates to `writeJsonFile` (atomic temp + rename) under the same
 *    file lock used by other persistence adapters.
 *
 * The Zod schema is private to this module. The {@link Config} type is
 * the public contract; serialization/validation rules are an
 * implementation detail.
 */
import { z } from 'zod';

import { StorageError } from '@src/domain/errors/storage-error.ts';
import { Result } from '@src/domain/result.ts';
import { SprintId } from '@src/domain/values/sprint-id.ts';
import type { FileLocker } from '@src/integration/persistence/file-locker.ts';
import { readJsonFile, writeJsonFile } from '@src/integration/persistence/json-io.ts';
import { ensureLayoutDirsOnce, type StoragePaths } from '@src/integration/persistence/storage-paths.ts';
import { CONFIG_DEFAULTS } from './config-defaults.ts';
import type { Config } from './config.ts';
import type { ConfigStorePort } from './config-store-port.ts';

/**
 * On-disk shape. Every field is optional + nullable so partial files
 * round-trip cleanly to the {@link CONFIG_DEFAULTS}-merged result. The
 * branded {@link SprintId} is validated through `SprintId.parse` (so the
 * disk shape stays plain `string` here and gets re-branded on load).
 */
const configFileSchema = z.object({
  currentSprint: z.string().nullable().optional(),
  aiProvider: z.enum(['claude', 'copilot']).nullable().optional(),
  editor: z.string().nullable().optional(),
  evaluationIterations: z.number().int().nonnegative().optional(),
  logLevel: z.enum(['debug', 'info', 'warn', 'error']).optional(),
});

type ConfigFileShape = z.infer<typeof configFileSchema>;

function toConfig(raw: ConfigFileShape): Result<Config, StorageError> {
  let currentSprint: Config['currentSprint'] = null;
  if (raw.currentSprint !== undefined && raw.currentSprint !== null) {
    const parsed = SprintId.parse(raw.currentSprint);
    if (!parsed.ok) {
      return Result.error(
        new StorageError({
          subCode: 'schema-mismatch',
          message: `config.currentSprint is not a valid sprint id: ${parsed.error.message}`,
          cause: parsed.error,
        })
      );
    }
    currentSprint = parsed.value;
  }

  return Result.ok({
    currentSprint,
    aiProvider: raw.aiProvider ?? CONFIG_DEFAULTS.aiProvider,
    editor: raw.editor ?? CONFIG_DEFAULTS.editor,
    evaluationIterations: raw.evaluationIterations ?? CONFIG_DEFAULTS.evaluationIterations,
    logLevel: raw.logLevel ?? CONFIG_DEFAULTS.logLevel,
  });
}

function fromConfig(config: Config): ConfigFileShape {
  return {
    currentSprint: config.currentSprint,
    aiProvider: config.aiProvider,
    editor: config.editor,
    evaluationIterations: config.evaluationIterations,
    logLevel: config.logLevel,
  };
}

function isMissingFile(err: StorageError): boolean {
  if (err.subCode !== 'io') return false;
  const cause = err.cause;
  if (cause instanceof Error && 'code' in cause) {
    return (cause as { code?: unknown }).code === 'ENOENT';
  }
  return false;
}

export class FileConfigStore implements ConfigStorePort {
  constructor(
    private readonly paths: StoragePaths,
    private readonly locker: FileLocker
  ) {}

  async load(): Promise<Result<Config, StorageError>> {
    const read = await readJsonFile(this.paths.configFile, configFileSchema);
    if (read.ok) return toConfig(read.value);
    if (isMissingFile(read.error)) return Result.ok(CONFIG_DEFAULTS);
    return Result.error(read.error);
  }

  async save(config: Config): Promise<Result<void, StorageError>> {
    const file = this.paths.configFile;
    await ensureLayoutDirsOnce(this.paths);
    const locked = await this.locker.withLock(file, () => writeJsonFile(file, fromConfig(config), configFileSchema));
    if (!locked.ok) return Result.error(locked.error);
    return locked.value;
  }
}
