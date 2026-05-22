import type { z } from 'zod';
import { Result } from '@src/domain/result.ts';
import { MigrationGapError } from '@src/domain/value/error/migration-gap-error.ts';
import { ParseError } from '@src/domain/value/error/parse-error.ts';

/**
 * One migration step. Transforms the previous version's raw shape into the next version's raw
 * shape. Pure function — no I/O, no exceptions; fail by returning a shape the next step (or
 * the final Zod parse) will reject.
 *
 * Mirrors {@link AiSignalsFileMigration} under `integration/ai/contract/_engine/types.ts` so
 * per-entity migrations and per-leaf signal-file migrations share a single mental model.
 */
export type EntityMigration = (raw: unknown) => unknown;

/**
 * Read the `schemaVersion` field from a raw JSON value. Defaults to `0` when missing or
 * malformed — pre-Wave-8 files had no version tag, so undefined ⇒ v0 (the legacy shape).
 */
export const readSchemaVersion = (raw: unknown): number => {
  if (typeof raw !== 'object' || raw === null) return 0;
  const value = (raw as { schemaVersion?: unknown }).schemaVersion;
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0;
};

/**
 * Walk a per-entity migration chain forward to `currentVersion`, then Zod-validate the final
 * shape. Mirrors the loop in `validate-signals-file.ts` from audit-[09] so entity-level
 * migrations and per-leaf signal-file migrations share one mental model.
 *
 * Steps run sequentially: `fileVersion → fileVersion+1 → … → currentVersion`. A missing step
 * fails with {@link MigrationGapError}; a final-shape Zod failure fails with {@link ParseError}
 * (subCode `'schema-mismatch'`). The caller's `decode()` wrapper folds either into a
 * `StorageError(subCode: 'parse')`.
 *
 * `filePath` is used purely for error messages so a downstream operator can locate the
 * offending artefact.
 */
export const runMigrations = <T>(
  raw: unknown,
  currentVersion: number,
  migrations: Readonly<Record<number, EntityMigration>>,
  schema: z.ZodType<T>,
  filePath: string
): Result<T, MigrationGapError | ParseError> => {
  const fileVersion = readSchemaVersion(raw);

  let current: unknown = raw;
  for (let v = fileVersion; v < currentVersion; v++) {
    const step = migrations[v];
    if (step === undefined) {
      return Result.error(new MigrationGapError({ from: v, to: currentVersion, file: filePath }));
    }
    current = step(current);
  }

  const parsed = schema.safeParse(current);
  if (!parsed.success) {
    return Result.error(
      new ParseError({
        subCode: 'schema-mismatch',
        message: `entity at ${filePath} failed schema validation: ${parsed.error.message}`,
        cause: parsed.error,
      })
    );
  }
  return Result.ok(parsed.data) as Result<T, MigrationGapError | ParseError>;
};
