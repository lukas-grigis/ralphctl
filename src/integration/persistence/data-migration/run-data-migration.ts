import type { Result } from '@src/domain/result.ts';
import type { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import {
  CURRENT_DATA_VERSION,
  type DataVersionMarker,
  needsMigration as markerNeedsMigration,
  readDataVersion,
  writeDataVersion,
} from '@src/integration/persistence/data-migration/version-marker.ts';
import { dryRun as scanDryRun } from '@src/integration/persistence/data-migration/dry-run.ts';
import {
  apply as applyMigration,
  type ApplyCtx,
  type ApplyResult,
} from '@src/integration/persistence/data-migration/apply.ts';
import type { DryRunReport } from '@src/integration/persistence/data-migration/types.ts';

/**
 * The migration engine, packaged as one cohesive object the consent-splash flow (Wave 2b) drives.
 * The three operations are exposed in the order the splash uses them:
 *
 *   1. {@link DataMigrationEngine.needsMigration} — gate. Mount the splash ONLY when this is `true`
 *      in an interactive TTY; a non-TTY / headless / CI launch skips silently and runs on the
 *      Wave-1 tolerant readers (re-offered next launch).
 *   2. {@link DataMigrationEngine.dryRun} — populate the splash summary (counts of planned renames
 *      + any problems). Touches NOTHING on disk.
 *   3. {@link DataMigrationEngine.apply} — on consent: lock-guard → backup → atomic per-item renames
 *      → learnings.md backfill → stamp the marker. Returns a discriminated {@link ApplyResult}.
 *
 * The TUI launch pre-flight (`launchTui`) drives this engine behind the consent splash. There is
 * no top-level side effect here; the engine never runs without that explicit consent (or the
 * no-op `stampCurrent` fast-path).
 *
 * @public
 */
export interface DataMigrationEngine {
  readonly needsMigration: (dataRoot: AbsolutePath) => Promise<boolean>;
  readonly dryRun: (dataRoot: AbsolutePath) => Promise<DryRunReport>;
  readonly apply: (dataRoot: AbsolutePath, report: DryRunReport, ctx: ApplyCtx) => Promise<ApplyResult>;
  /**
   * Stamp the marker to CURRENT without any rename / backup. The gate calls this for a NO-OP dry-run
   * (nothing planned, nothing to merge, no problems — e.g. a brand-new install or an already-reconciled
   * tree) so a new user never sees a pointless "migrate" prompt: the marker simply advances and the app
   * boots straight through.
   */
  readonly stampCurrent: (dataRoot: AbsolutePath, appVersion: string) => Promise<Result<void, StorageError>>;
  /**
   * Read the on-disk version marker. The failure screen uses `lastWrittenByAppVersion` to decide
   * whether it can honestly name a downgrade version — an absent / empty value means it must NOT
   * print a version-specific install command (the current version still reads the data).
   */
  readonly readMarker: (dataRoot: AbsolutePath) => Promise<DataVersionMarker>;
}

/**
 * Build the data-migration engine. A factory (not a module-level singleton) so callers can wire a
 * test double, and so the engine carries no hidden global state. Pure construction — no I/O.
 *
 * @public
 */
export const createDataMigrationEngine = (): DataMigrationEngine => ({
  needsMigration: markerNeedsMigration,
  dryRun: scanDryRun,
  apply: applyMigration,
  stampCurrent: (dataRoot, appVersion) =>
    writeDataVersion(dataRoot, { dataVersion: CURRENT_DATA_VERSION, lastWrittenByAppVersion: appVersion }),
  readMarker: readDataVersion,
});
