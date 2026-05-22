import type { EntityMigration } from '@src/integration/persistence/_engine/run-migrations.ts';

/**
 * Current on-disk schema version for `tasks.json`.
 *
 *   v0 — pre-Wave-8 shape. The file root was a bare `Task[]` array; rows inside each
 *        attempt's `verifyRuns` carried `stdoutTailBytes`. Some rows used the pre-rename
 *        `checkRuns` field instead of `verifyRuns`.
 *   v1 — Wave 8: file root is `{ schemaVersion: 1, tasks: Task[] }`; `stdoutTailBytes`
 *        dropped from every `verifyRuns` row (bodies live under `<sprintDir>/logs/verify/`);
 *        `checkRuns` rewritten to `verifyRuns`.
 */
export const TASKS_FILE_SCHEMA_VERSION = 1 as const;

/**
 * Per-version migration chain for `tasks.json`. Each step is `v → v+1`.
 *
 * `migrations[0]` wraps the legacy bare-array root into the new `{ schemaVersion, tasks }`
 * envelope, then walks every attempt's `verifyRuns` (or its `checkRuns` predecessor) and
 * drops the embedded tail-bytes field. The legacy `checkRuns` alias is lifted to
 * `verifyRuns` so the downstream schema sees one canonical shape.
 */
export const tasksFileMigrations: Readonly<Record<number, EntityMigration>> = {
  0: (raw: unknown): unknown => {
    // The legacy file root was a `Task[]` array; the new shape is `{ schemaVersion, tasks }`.
    let tasks: readonly unknown[];
    if (Array.isArray(raw)) {
      tasks = raw;
    } else if (typeof raw === 'object' && raw !== null && Array.isArray((raw as { tasks?: unknown }).tasks)) {
      tasks = (raw as { tasks: readonly unknown[] }).tasks;
    } else {
      // Unknown shape — pass through; the downstream schema parse will reject it.
      return raw;
    }

    return {
      tasks: tasks.map((task) => {
        if (typeof task !== 'object' || task === null) return task;
        const t = { ...(task as Record<string, unknown>) };
        if (!Array.isArray(t.attempts)) return t;
        t.attempts = t.attempts.map((attempt) => {
          if (typeof attempt !== 'object' || attempt === null) return attempt;
          const att = { ...(attempt as Record<string, unknown>) };
          const checkRuns = att.checkRuns;
          const verifyRuns = att.verifyRuns;
          const runs = verifyRuns ?? checkRuns;
          if (Array.isArray(runs)) {
            att.verifyRuns = runs.map((row) => {
              if (typeof row !== 'object' || row === null) return row;
              const rest: Record<string, unknown> = { ...(row as Record<string, unknown>) };
              delete rest.stdoutTailBytes;
              return rest;
            });
          }
          delete att.checkRuns;
          return att;
        });
        return t;
      }),
    };
  },
};
