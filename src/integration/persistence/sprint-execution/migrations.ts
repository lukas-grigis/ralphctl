import type { EntityMigration } from '@src/integration/persistence/_engine/run-migrations.ts';

/**
 * Current on-disk schema version for `execution.json`.
 *
 *   v0 — pre-Wave-8: `setupRanAt[]` rows carry `stdoutTailBytes` / `stderrTailBytes`. Some
 *        v0 files also omit the top-level `id` field (a yet earlier shape where execution
 *        was keyed by `sprintId` alone).
 *   v1 — Wave 8: tail-bytes fields removed (full output lives under `<sprintDir>/logs/`);
 *        top-level `id` always present.
 */
export const SPRINT_EXECUTION_SCHEMA_VERSION = 1 as const;

/**
 * Per-version migration chain for `execution.json`. Each step is `v → v+1`.
 *
 * `migrations[0]` consolidates every pre-Wave-8 quirk in one place: drop the embedded
 * stdout/stderr tail fields on `setupRanAt` rows (bodies live at `<sprintDir>/logs/setup/`
 * now), fill the missing `id` field from `sprintId`, and upgrade the very-early two-field
 * row shape (`{ repositoryId, ranAt }`) to the structured row schema. The latter two were
 * previously handled by ad-hoc shims in `sprint-execution.schema.ts`; folding them into
 * a single migration step makes the upgrade path one mechanism rather than three.
 */
export const sprintExecutionMigrations: Readonly<Record<number, EntityMigration>> = {
  0: (raw: unknown): unknown => {
    if (typeof raw !== 'object' || raw === null) return raw;
    const obj = { ...(raw as Record<string, unknown>) };

    // Earlier formats lacked the `Entity<SprintId>.id` field. Fill it in from `sprintId`.
    if (!('id' in obj) && 'sprintId' in obj) {
      obj.id = obj.sprintId;
    }

    // Migrate each `setupRanAt` row: drop tail-bytes; fill structured fields for the
    // very-early two-field shape; preserve everything else verbatim.
    const runs = obj.setupRanAt;
    if (Array.isArray(runs)) {
      obj.setupRanAt = runs.map((run) => {
        if (typeof run !== 'object' || run === null) return run;
        const rest: Record<string, unknown> = { ...(run as Record<string, unknown>) };
        delete rest.stdoutTailBytes;
        delete rest.stderrTailBytes;
        // Already structured? (`outcome` is the unambiguous marker.)
        if ('outcome' in rest) return rest;
        // Two-field shape — populate neutral defaults so the new schema accepts it.
        return {
          ...rest,
          command: typeof rest.command === 'string' ? rest.command : '',
          exitCode: typeof rest.exitCode === 'number' ? rest.exitCode : 0,
          durationMs: typeof rest.durationMs === 'number' ? rest.durationMs : 0,
          outcome: 'success',
        };
      });
    }
    return obj;
  },
};
