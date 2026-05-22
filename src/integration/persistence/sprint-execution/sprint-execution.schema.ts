import { z } from 'zod';
import type { Result } from '@src/domain/result.ts';
import type { SprintExecution } from '@src/domain/entity/sprint-execution.ts';
import type { MigrationGapError } from '@src/domain/value/error/migration-gap-error.ts';
import type { ParseError } from '@src/domain/value/error/parse-error.ts';
import { HttpUrlSchema, SprintIdSchema } from '@src/integration/persistence/shared/value-schemas.ts';
import { SetupRunSchema } from '@src/integration/persistence/sprint-execution/setup-run.schema.ts';
import {
  SPRINT_EXECUTION_SCHEMA_VERSION,
  sprintExecutionMigrations,
} from '@src/integration/persistence/sprint-execution/migrations.ts';
import { runMigrations } from '@src/integration/persistence/_engine/run-migrations.ts';
import { type Compatible } from '@src/integration/persistence/shared/codec-internal.ts';

/**
 * On-disk shape for `execution.json` at the current schema version. The `schemaVersion`
 * field is a literal — older shapes get migrated forward by
 * {@link sprintExecutionMigrations} before this schema sees them, so the parse always
 * succeeds against the post-migration form.
 *
 * `id` and `sprintId` carry the same value — execution is keyed by the partner sprint.
 * Both fields are persisted so the on-disk record satisfies `Entity<SprintId>` without
 * losing the historical `sprintId` field name.
 */
export const SprintExecutionSchema = z.object({
  schemaVersion: z.literal(SPRINT_EXECUTION_SCHEMA_VERSION).default(SPRINT_EXECUTION_SCHEMA_VERSION),
  id: SprintIdSchema,
  sprintId: SprintIdSchema,
  branch: z.union([z.string(), z.null()]),
  pullRequestUrl: z.union([HttpUrlSchema, z.null()]),
  setupRanAt: z.array(SetupRunSchema).readonly(),
});

/**
 * Decode a persisted `execution.json` payload. Walks the per-entity migration chain forward
 * to the current `SPRINT_EXECUTION_SCHEMA_VERSION`, then Zod-parses the final shape. Returns
 * `MigrationGapError` when a step is missing for an unrecognised version, `ParseError` when
 * the final shape doesn't validate.
 */
export const fromJsonSprintExecution = (
  input: unknown,
  filePath = 'execution.json'
): Result<SprintExecution, MigrationGapError | ParseError> =>
  runMigrations<SprintExecution>(
    input,
    SPRINT_EXECUTION_SCHEMA_VERSION,
    sprintExecutionMigrations,
    PersistedSchema,
    filePath
  );

/**
 * The persisted file carries `schemaVersion`; the in-memory domain entity does not. Strip
 * the field at the schema boundary so the rest of the codebase consumes a pure domain shape.
 */
const PersistedSchema = SprintExecutionSchema.transform((value) => {
  const next: Record<string, unknown> = { ...value };
  delete next.schemaVersion;
  return next as unknown as SprintExecution;
});

/**
 * Re-stamp the file with the current `schemaVersion` so an old file written without the
 * field heals on the next save. The in-memory entity does not carry the version.
 */
export const toJsonSprintExecution = (execution: SprintExecution): unknown => ({
  schemaVersion: SPRINT_EXECUTION_SCHEMA_VERSION,
  ...execution,
});

type _checkSprintExecution = Compatible<SprintExecution, Omit<z.infer<typeof SprintExecutionSchema>, 'schemaVersion'>>;
const _typeChecks: [_checkSprintExecution] = [true];
void _typeChecks;
