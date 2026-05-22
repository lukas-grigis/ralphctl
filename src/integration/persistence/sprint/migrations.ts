import type { EntityMigration } from '@src/integration/persistence/_engine/run-migrations.ts';

/**
 * Current on-disk schema version for `sprint.json`.
 *
 *   v0 — pre-Wave-8 shape (no `schemaVersion` field).
 *   v1 — Wave 8: adds the `schemaVersion` envelope field. The domain shape itself is
 *        structurally identical; only the version tag is new.
 */
export const SPRINT_SCHEMA_VERSION = 1 as const;

/**
 * Per-version migration chain for `sprint.json`. Each step is `v → v+1`.
 *
 * `migrations[0]` is the inaugural step — Wave 8 added per-entity versioning but did not
 * change the on-disk shape of a sprint. The step simply passes through the raw value; the
 * downstream wrapper stamps the version literal at save time.
 */
export const sprintMigrations: Readonly<Record<number, EntityMigration>> = {
  0: (raw: unknown): unknown => raw,
};
