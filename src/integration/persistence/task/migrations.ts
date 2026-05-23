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
 *   v2 — Evaluator-rubric redesign: `verificationCriteria` is now a structured array
 *        (`{ id, assertion, check, command? }`) instead of `string[]`. Legacy entries are
 *        lifted to `{ id: 'C${i+1}', assertion: <str>, check: 'manual' }` so the upgrade is
 *        forward-only at the schema layer and no downstream consumer has to special-case
 *        the legacy shape.
 */
export const TASKS_FILE_SCHEMA_VERSION = 2 as const;

/**
 * Per-version migration chain for `tasks.json`. Each step is `v → v+1`.
 *
 * `migrations[0]` wraps the legacy bare-array root into the new `{ schemaVersion, tasks }`
 * envelope, then walks every attempt's `verifyRuns` (or its `checkRuns` predecessor) and
 * drops the embedded tail-bytes field. The legacy `checkRuns` alias is lifted to
 * `verifyRuns` so the downstream schema sees one canonical shape.
 *
 * `migrations[1]` normalises `verificationCriteria` from the legacy `string[]` to the
 * structured `{ id, assertion, check }` shape. The Zod parser's read-time normalizer also
 * accepts the legacy shape on read; this step is what makes the rewritten file persist in
 * the structured shape so the next read avoids the normalisation cost.
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
  1: (raw: unknown): unknown => {
    if (typeof raw !== 'object' || raw === null) return raw;
    const file = raw as { tasks?: unknown };
    if (!Array.isArray(file.tasks)) return raw;
    const next = file.tasks.map((task) => {
      if (typeof task !== 'object' || task === null) return task;
      const t = { ...(task as Record<string, unknown>) };
      const crit = t.verificationCriteria;
      if (!Array.isArray(crit)) return t;
      t.verificationCriteria = crit.map((entry, i) => {
        if (typeof entry === 'string') {
          return { id: `C${String(i + 1)}`, assertion: entry, check: 'manual' };
        }
        return entry;
      });
      return t;
    });
    // Drop the legacy schemaVersion so the downstream schema's `.default(2)` fills the canonical
    // value; otherwise the stale `1` literal collides with the schema's `z.literal(2)`.
    const { schemaVersion: _drop, ...rest } = raw as Record<string, unknown>;
    void _drop;
    return { ...rest, tasks: next };
  },
};
