/**
 * Forward migrations for the persisted settings JSON.
 *
 * Each migration is a pure function `(unknown) => unknown` keyed by `from → to` schema version.
 * The load path picks up where the file is and applies migrations in order until it reaches
 * {@link CURRENT_SCHEMA_VERSION}; zod validation only ever sees the current shape.
 *
 * Why hand-rolled instead of zustand/immer or a runtime migrator library: we have one file,
 * a small schema, and a typed result envelope. The whole framework is ~40 lines, no extra
 * runtime deps, and the migrations themselves stay close to the schema they evolve.
 */

import { CURRENT_SCHEMA_VERSION } from '@src/domain/entity/settings.ts';

export interface SettingsMigration {
  readonly from: number;
  readonly to: number;
  /**
   * Takes the raw object (a structurally cloned `Record<string, unknown>`) and returns the
   * upgraded shape. Must be pure: no I/O, no exceptions — fail by returning a value the next
   * step (or the final zod parse) will reject.
   */
  readonly migrate: (raw: Record<string, unknown>) => Record<string, unknown>;
}

/**
 * v1 → v2: collapse the single-provider discriminated union into five per-flow rows. Every
 * row inherits the v1 root provider; per-flow `model` is preserved verbatim from
 * `ai.models.<flow>`. Effort is seeded so the post-migration matrix matches the v1 implicit
 * behaviour: global `high` default, with `implement` and `plan` bumped to `xhigh` (those
 * historically benefited from the deeper reasoning level under the unified harness) and
 * `readiness` floored to `medium` (a read-only inventory round-trip — `xhigh` is wasteful).
 * Runs silently; the user does not see a banner or warning when the migration fires.
 */
const FLOW_KEYS = ['refine', 'plan', 'implement', 'readiness', 'ideate', 'createPr'] as const;

const migrateV1ToV2 = (raw: Record<string, unknown>): Record<string, unknown> => {
  const aiRaw = raw['ai'];
  if (typeof aiRaw !== 'object' || aiRaw === null) return raw;
  const ai = aiRaw as { readonly provider?: unknown; readonly models?: unknown };
  if (typeof ai.provider !== 'string') return raw;
  const provider = ai.provider;
  const models = (typeof ai.models === 'object' && ai.models !== null ? ai.models : {}) as Record<string, unknown>;
  const perFlowEffortOverrides: Readonly<Partial<Record<(typeof FLOW_KEYS)[number], string>>> = {
    implement: 'xhigh',
    plan: 'xhigh',
    readiness: 'medium',
  };
  const nextAi: Record<string, unknown> = { effort: 'high' };
  for (const flow of FLOW_KEYS) {
    // v1 never had a `models.createPr` slot — the harness reused `models.refine` for the
    // PR-content draft. Fall back to refine here so the migrated row points at a sensible
    // model rather than emitting an off-catalog blank.
    const modelRaw = flow === 'createPr' ? models['refine'] : models[flow];
    const row: Record<string, unknown> = {
      provider,
      ...(typeof modelRaw === 'string' ? { model: modelRaw } : {}),
    };
    const override = perFlowEffortOverrides[flow];
    if (override !== undefined) row['effort'] = override;
    nextAi[flow] = row;
  }
  return { ...raw, ai: nextAi };
};

/**
 * Ordered chain of upgrades from older versions to {@link CURRENT_SCHEMA_VERSION}. The
 * migration runner walks them in `from → to` order; gaps abort the chain (the result's
 * `toVersion` mismatches `CURRENT_SCHEMA_VERSION` and the load path surfaces a `ParseError`).
 */
export const SETTINGS_MIGRATIONS: readonly SettingsMigration[] = [{ from: 1, to: 2, migrate: migrateV1ToV2 }];

/**
 * Read the `schemaVersion` field from a raw object, defaulting to `1` when missing or
 * malformed — the very first persisted format had no version tag, so undefined ⇒ v1.
 */
export const readSchemaVersion = (raw: unknown): number => {
  if (typeof raw !== 'object' || raw === null) return 1;
  const value = (raw as Record<string, unknown>).schemaVersion;
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : 1;
};

export interface MigrationOutcome {
  /** The upgraded raw object, ready for zod validation. */
  readonly value: Record<string, unknown>;
  /** Version detected on the input. */
  readonly fromVersion: number;
  /** Version after applying every available migration. May be lower than current if no chain exists. */
  readonly toVersion: number;
  /** Migrations actually executed, in application order. Length 0 means nothing changed. */
  readonly applied: readonly SettingsMigration[];
}

/**
 * Walk the migration chain from the input's `schemaVersion` up to {@link CURRENT_SCHEMA_VERSION}.
 * Stops early if the chain has a gap — callers inspect `toVersion` against `CURRENT_SCHEMA_VERSION`
 * to detect an unreachable target.
 */
export const applyMigrations = (raw: unknown): MigrationOutcome => {
  const fromVersion = readSchemaVersion(raw);
  let current: Record<string, unknown> =
    typeof raw === 'object' && raw !== null ? { ...(raw as Record<string, unknown>) } : {};

  const applied: SettingsMigration[] = [];
  let version = fromVersion;
  while (version < CURRENT_SCHEMA_VERSION) {
    const step = SETTINGS_MIGRATIONS.find((m) => m.from === version);
    if (step === undefined) break;
    current = step.migrate(current);
    current.schemaVersion = step.to;
    applied.push(step);
    version = step.to;
  }
  return { value: current, fromVersion, toVersion: version, applied };
};
