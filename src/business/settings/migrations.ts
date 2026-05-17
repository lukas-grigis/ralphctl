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
 * Ordered chain of upgrades from older versions to {@link CURRENT_SCHEMA_VERSION}. Currently
 * empty — v1 is the inaugural format. Future schema bumps add entries here in `from → to`
 * order; the migration runner walks them automatically.
 */
export const SETTINGS_MIGRATIONS: readonly SettingsMigration[] = [];

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
